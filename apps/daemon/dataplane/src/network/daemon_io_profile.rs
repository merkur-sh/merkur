//! Daemon non-display I/O profiles: keystroke admission (record decode, mode
//! encoding, PTY FIFO entry), bracketed-paste encoding, the input-ack and
//! heartbeat datagram send on real edge and direct QUIC carriers, and the
//! per-keystroke profiling hooks.
//!
//! Every test here is an ignored profile. Deterministic counts (allocation
//! requests and bytes on the calling thread, wire payload identity) are the
//! evidence; timings are paired and interleaved in one process (ABBA) and are
//! diagnostic only. Where a profile names a `candidate`, the candidate is a
//! local copy of a proposed production change, run against the production
//! function in the same process so both see the same machine state.
//!
//! Run one at a time, release build:
//!
//! ```sh
//! cargo test --release --locked -p merkur-dataplane \
//!   network::daemon_io_profile::<name> -- --ignored --exact --nocapture --test-threads=1
//! ```

use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::cell::Hyperlink;

use tokio::sync::mpsc;
use wtransport::tls::Sha256Digest;
use wtransport::{ClientConfig, Endpoint};

use crate::connection::PeerTransport;
use crate::edge_tunnel::{CounterpartState, EdgeTunnel, test_allocations};
use crate::network::input_record::{self, InputRecord, build, mods};
use crate::network::peer::{INLINE_RELIABLE_PAYLOAD_BYTES, ReliablePayload};
use crate::network::protocol::{CHANNEL_PTY, EdgeLane};
use crate::perf_timing::{DisplaySendStamps, PerfTimingTracker};
use crate::pty::input_encoder::{self, Sink};
use crate::pty::{PtyWritePayload, PtyWriter};
use crate::webtransport::{self, DirectSession};

// ---------------------------------------------------------------------------
// Shared reporting
// ---------------------------------------------------------------------------

fn percentile(sorted: &[f64], ratio: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() as f64 * ratio).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    sorted[index]
}

fn summarize(name: &str, samples: &mut [f64], unit: &str) -> (f64, f64) {
    samples.sort_by(f64::total_cmp);
    let p50 = percentile(samples, 0.50);
    let p95 = percentile(samples, 0.95);
    for (ratio, value) in [(0.50, p50), (0.95, p95)] {
        println!(
            "@@merkur-perf {{\"name\":\"{name}\",\"value\":{value:.3},\"unit\":\"{unit}\",\"direction\":\"lower\",\"percentile\":{ratio},\"sampleSize\":{}}}",
            samples.len()
        );
    }
    (p50, p95)
}

fn count_metric(name: &str, value: f64, unit: &str, sample_size: usize) {
    println!(
        "@@merkur-perf {{\"name\":\"{name}\",\"value\":{value:.3},\"unit\":\"{unit}\",\"direction\":\"lower\",\"sampleSize\":{sample_size}}}"
    );
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

// ---------------------------------------------------------------------------
// Keystroke admission: decode -> encode -> PTY FIFO entry
// ---------------------------------------------------------------------------

struct NullWriter;

impl Write for NullWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

const ESCAPE: u32 = 0xE000;
const ENTER: u32 = 0xE001;
const BACKSPACE: u32 = 0xE003;
const LEFT: u32 = 0xE006;
const RIGHT: u32 = 0xE007;
const UP: u32 = 0xE008;
const DOWN: u32 = 0xE009;

fn release(key: u32, mod_bits: u8) -> Vec<u8> {
    build::key(build::Key {
        event: 2,
        key,
        mods: mod_bits,
        ..build::Key::default()
    })
}

fn typed_line(line: &str) -> Vec<Vec<u8>> {
    let mut records = Vec::new();
    for c in line.chars() {
        records.push(build::press(c));
        records.push(release(u32::from(c), 0));
    }
    records.push(build::functional(ENTER, 0, 0));
    records.push(release(ENTER, 0));
    records
}

fn text_of_len(bytes: usize) -> String {
    // CJK (3 bytes) then ASCII to land exactly on `bytes`: an IME commit or a
    // soft-keyboard word, the shape `sendNativeText` sends as one record.
    let mut text = String::new();
    while text.len() + 3 <= bytes {
        text.push('語');
    }
    while text.len() < bytes {
        text.push('a');
    }
    assert_eq!(text.len(), bytes);
    text
}

fn source_paste(bytes: usize, esc_every: Option<usize>) -> String {
    let line = "    let encoded = input_encoder::encode(&decoded, mode, &mut payload); // ok\n";
    let mut text = String::with_capacity(bytes + line.len());
    let mut since_esc = 0;
    while text.len() < bytes {
        for c in line.chars() {
            if text.len() == bytes {
                break;
            }
            if let Some(every) = esc_every
                && since_esc >= every
            {
                text.push('\u{1b}');
                since_esc = 0;
                continue;
            }
            text.push(c);
            since_esc += 1;
        }
    }
    text
}

fn utf8_paste(bytes: usize) -> String {
    let unit = "終端 ターミナル 🚀 emoji and ASCII mixed in one pasted line.\n";
    let mut text = String::with_capacity(bytes + unit.len());
    'fill: while text.len() < bytes {
        for c in unit.chars() {
            if text.len() + c.len_utf8() > bytes {
                break 'fill;
            }
            text.push(c);
        }
    }
    text
}

struct Workload {
    name: &'static str,
    mode: TermMode,
    records: Vec<Vec<u8>>,
}

fn shell_mode() -> TermMode {
    TermMode::default() | TermMode::BRACKETED_PASTE
}

fn keystroke_workloads() -> Vec<Workload> {
    let kitty_all = TermMode::DISAMBIGUATE_ESC_CODES
        | TermMode::REPORT_EVENT_TYPES
        | TermMode::REPORT_ALTERNATE_KEYS
        | TermMode::REPORT_ALL_KEYS_AS_ESC
        | TermMode::REPORT_ASSOCIATED_TEXT;
    let mut kitty = Vec::new();
    for c in "helix editing".chars() {
        let key = u32::from(c.to_ascii_lowercase());
        let shifted = c
            .is_ascii_alphabetic()
            .then(|| u32::from(c.to_ascii_uppercase()));
        for event in [0u8, 1, 2] {
            kitty.push(build::key(build::Key {
                event,
                key,
                mods: mods::SHIFT,
                shifted,
                base: Some(key),
                ..build::Key::default()
            }));
        }
    }
    let mut arrows = Vec::new();
    for key in [UP, DOWN, LEFT, RIGHT, UP, UP, DOWN, LEFT] {
        arrows.push(build::functional(key, 0, 0));
        arrows.push(release(key, 0));
    }
    let mut ctrl = Vec::new();
    for c in "wbrfaeu".chars() {
        ctrl.push(build::key(build::Key {
            key: u32::from(c),
            mods: mods::CTRL,
            ..build::Key::default()
        }));
        ctrl.push(release(u32::from(c), mods::CTRL));
    }
    ctrl.push(build::functional(RIGHT, 0, mods::CTRL));
    ctrl.push(build::functional(BACKSPACE, 0, mods::ALT));
    ctrl.push(build::functional(ESCAPE, 0, 0));
    let mut motion = Vec::new();
    for step in 0..32u32 {
        motion.push(build::mouse(2, 3, 0, 10 + step * 3, 5 + step / 2));
    }
    let mut wheel = Vec::new();
    for step in 0..16u32 {
        wheel.push(build::wheel((step % 2) as u8, 0, 1, 80, 24));
    }

    let mut workloads = vec![
        Workload {
            name: "ascii-typing-legacy",
            mode: shell_mode(),
            records: typed_line("git commit -m 'fix the quick brown fox'"),
        },
        Workload {
            name: "arrows-decckm",
            mode: shell_mode() | TermMode::APP_CURSOR,
            records: arrows,
        },
        Workload {
            name: "ctrl-modify-other-keys-2",
            mode: shell_mode() | TermMode::MODIFY_OTHER_KEYS_2,
            records: ctrl,
        },
        Workload {
            name: "kitty-all-flags-shifted",
            mode: kitty_all,
            records: kitty,
        },
        Workload {
            name: "mouse-motion-sgr",
            mode: TermMode::SGR_MOUSE | TermMode::MOUSE_MOTION,
            records: motion,
        },
        Workload {
            name: "wheel-sgr",
            mode: TermMode::SGR_MOUSE | TermMode::MOUSE_REPORT_CLICK,
            records: wheel,
        },
    ];
    for bytes in [1usize, 6, 10, 11, 16, 22, 23, 24, 32] {
        workloads.push(Workload {
            name: Box::leak(format!("text-record-{bytes}B").into_boxed_str()),
            mode: shell_mode(),
            records: vec![build::text(&text_of_len(bytes)); 16],
        });
    }
    workloads.push(Workload {
        name: "paste-8KiB-bracketed",
        mode: shell_mode(),
        records: vec![build::paste(&source_paste(8 * 1024, None)); 4],
    });
    workloads.push(Workload {
        name: "paste-64KiB-bracketed",
        mode: shell_mode(),
        records: vec![build::paste(&source_paste(63 * 1024, None)); 2],
    });
    workloads
}

/// Proposed hint: exact for text (the head byte is dropped and a line feed
/// becomes a carriage return one for one), unchanged for every other kind.
fn candidate_len_hint(record: &[u8]) -> usize {
    match record.first().map(|head| head >> 5) {
        Some(input_record::KIND_TEXT) => record.len() - 1,
        _ => input_encoder::encoded_len_hint(record),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HintArm {
    Production,
    Candidate,
}

fn encode_payload(record: &[u8], mode: TermMode, arm: HintArm) -> PtyWritePayload {
    let decoded = input_record::decode(record).expect("canonical record");
    let hint = match arm {
        HintArm::Production => input_encoder::encoded_len_hint(record),
        HintArm::Candidate => candidate_len_hint(record),
    };
    let mut payload = PtyWritePayload::with_capacity(hint);
    input_encoder::encode(&decoded, mode, &mut payload);
    payload
}

/// Owner-loop work for one input record, as `admit_user_record` performs it:
/// decode, capacity from the hint, encode against the terminal modes, enqueue.
/// Terminal focus and shadow-model bookkeeping are outside this module.
#[test]
#[ignore = "daemon-io keystroke admission profile"]
fn keystroke_admission_profile() {
    let rounds = env_usize("BENCH_SAMPLES", 200);
    let (mut writer, mut completions) = PtyWriter::new(Box::new(NullWriter)).expect("writer");
    let peer: Arc<str> = Arc::from("browser-profile");
    let mut seq = 0u32;
    let mut outstanding = 0usize;
    let mut drain = |writer: &mut PtyWriter, outstanding: &mut usize| {
        while *outstanding > 0 {
            match completions.try_recv() {
                Ok(completion) => {
                    writer.finish(&completion);
                    *outstanding -= 1;
                }
                Err(_) => std::thread::yield_now(),
            }
        }
    };

    println!(
        "{:<28} {:>9} {:>10} {:>11} {:>11} {:>10} {:>10}",
        "workload", "records", "owner a/r", "owner B/r", "cand a/r", "global a/r", "p50 ns/r"
    );
    for workload in keystroke_workloads() {
        let records = &workload.records;
        let enqueue = |arm: HintArm, writer: &mut PtyWriter, seq: &mut u32| {
            for record in records {
                let payload = encode_payload(record, workload.mode, arm);
                writer
                    .try_enqueue_user(Arc::clone(&peer), *seq, PeerTransport::Edge, payload, None)
                    .expect("bounded FIFO has room: completions are drained per pass");
                *seq = seq.wrapping_add(1);
            }
        };
        // Warm the FIFO, the completion list and the allocator's size classes.
        for _ in 0..4 {
            enqueue(HintArm::Production, &mut writer, &mut seq);
            outstanding += records.len();
            drain(&mut writer, &mut outstanding);
        }

        // Owner thread, production and candidate hint, deterministic counts.
        test_allocations::begin_thread();
        enqueue(HintArm::Production, &mut writer, &mut seq);
        let owner = test_allocations::end_thread();
        outstanding += records.len();
        drain(&mut writer, &mut outstanding);
        test_allocations::begin_thread();
        enqueue(HintArm::Candidate, &mut writer, &mut seq);
        let candidate = test_allocations::end_thread();
        outstanding += records.len();
        drain(&mut writer, &mut outstanding);

        // Every thread (owner + PTY writer + completion channel), production.
        // A multi-line paste is paced into the PTY at two lines per
        // millisecond, so its passes are wall-clock bound: fewer of them.
        let paste = records.iter().map(Vec::len).sum::<usize>() > 4096;
        let passes = if paste { 4 } else { 64 };
        let rounds = if paste { rounds.min(16) } else { rounds };
        test_allocations::begin();
        for _ in 0..passes {
            enqueue(HintArm::Production, &mut writer, &mut seq);
            outstanding += records.len();
            drain(&mut writer, &mut outstanding);
        }
        let global = test_allocations::end();

        // Owner-thread CPU per record, production path, many passes.
        let mut samples = Vec::with_capacity(rounds);
        for _ in 0..rounds {
            let started = Instant::now();
            enqueue(HintArm::Production, &mut writer, &mut seq);
            samples.push(started.elapsed().as_nanos() as f64 / records.len() as f64);
            outstanding += records.len();
            drain(&mut writer, &mut outstanding);
        }
        let n = records.len() as f64;
        let (p50, _) = summarize(
            &format!("daemon-io-admission-{}-owner", workload.name),
            &mut samples,
            "ns/record",
        );
        count_metric(
            &format!("daemon-io-admission-{}-owner-allocations", workload.name),
            owner.allocations as f64 / n,
            "allocations/record",
            records.len(),
        );
        count_metric(
            &format!(
                "daemon-io-admission-{}-candidate-allocations",
                workload.name
            ),
            candidate.allocations as f64 / n,
            "allocations/record",
            records.len(),
        );
        count_metric(
            &format!("daemon-io-admission-{}-global-allocations", workload.name),
            global.allocations as f64 / (n * passes as f64),
            "allocations/record",
            records.len() * passes,
        );
        println!(
            "{:<28} {:>9} {:>10.3} {:>11.1} {:>11.3} {:>10.3} {:>10.1}",
            workload.name,
            records.len(),
            owner.allocations as f64 / n,
            owner.allocated_bytes as f64 / n,
            candidate.allocations as f64 / n,
            global.allocations as f64 / (n * passes as f64),
            p50,
        );
    }
}

/// The candidate hint must bound every text record's encoding, so the payload
/// never has to grow, and must never change a byte.
#[test]
#[ignore = "daemon-io keystroke admission profile"]
fn candidate_text_hint_is_an_exact_bound() {
    for text in [
        "a",
        "\n",
        "a\nb\n",
        "終端\nターミナル",
        "🚀🚀🚀🚀🚀🚀",
        "\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n",
        &text_of_len(23),
        &text_of_len(24),
        &text_of_len(4096),
    ] {
        let record = build::text(text);
        let Some(InputRecord::Text(decoded)) = input_record::decode(&record) else {
            panic!("text record");
        };
        let mut out = Vec::new();
        input_encoder::encode(&InputRecord::Text(decoded), shell_mode(), &mut out);
        assert_eq!(out.len(), candidate_len_hint(&record), "{text:?}");
        assert!(candidate_len_hint(&record) <= input_encoder::encoded_len_hint(&record));
    }
}

// ---------------------------------------------------------------------------
// Bracketed paste encoding
// ---------------------------------------------------------------------------

const BRACKETED_PASTE_OPEN: &[u8] = b"\x1b[200~";
const BRACKETED_PASTE_CLOSE: &[u8] = b"\x1b[201~";

/// Proposed `encode_paste`: split the `str` on the ESC char. ESC is ASCII, so it
/// never occurs inside a multi-byte sequence: the segments are exactly the byte
/// split's, and `str::split(char)` finds a one-byte needle with core's
/// word-at-a-time `memchr` instead of a per-byte predicate.
fn candidate_encode_paste(text: &str, mode: TermMode, out: &mut impl Sink) {
    if !mode.contains(TermMode::BRACKETED_PASTE) {
        out.put(text.as_bytes());
        return;
    }
    out.put(BRACKETED_PASTE_OPEN);
    for segment in text.split('\u{1b}') {
        out.put(segment.as_bytes());
    }
    out.put(BRACKETED_PASTE_CLOSE);
}

/// Alternative design: the `memchr` crate (already a dataplane dependency)
/// finds each ESC with the target's SIMD search. Same segments, same bytes.
fn memchr_encode_paste(text: &str, mode: TermMode, out: &mut impl Sink) {
    if !mode.contains(TermMode::BRACKETED_PASTE) {
        out.put(text.as_bytes());
        return;
    }
    out.put(BRACKETED_PASTE_OPEN);
    let bytes = text.as_bytes();
    let mut start = 0;
    for esc in memchr::memchr_iter(0x1b, bytes) {
        out.put(&bytes[start..esc]);
        start = esc + 1;
    }
    out.put(&bytes[start..]);
    out.put(BRACKETED_PASTE_CLOSE);
}

#[derive(Clone, Copy)]
enum PasteArm {
    Production,
    StrSplit,
    Memchr,
}

/// Every order of the three arms, cycled per sample so none always runs first.
const PASTE_ARM_ORDERS: [[PasteArm; 3]; 6] = [
    [PasteArm::Production, PasteArm::StrSplit, PasteArm::Memchr],
    [PasteArm::Memchr, PasteArm::StrSplit, PasteArm::Production],
    [PasteArm::StrSplit, PasteArm::Memchr, PasteArm::Production],
    [PasteArm::Production, PasteArm::Memchr, PasteArm::StrSplit],
    [PasteArm::Memchr, PasteArm::Production, PasteArm::StrSplit],
    [PasteArm::StrSplit, PasteArm::Production, PasteArm::Memchr],
];

#[test]
#[ignore = "daemon-io paste encoding profile"]
fn paste_encode_benchmark() {
    let samples = env_usize("BENCH_SAMPLES", 400);
    let reps = env_usize("BENCH_REPS", 8);
    let mode = shell_mode();
    let cases: Vec<(&str, String)> = vec![
        ("ascii-source-8KiB", source_paste(8 * 1024, None)),
        (
            "ascii-esc-every-512-8KiB",
            source_paste(8 * 1024, Some(512)),
        ),
        ("utf8-mixed-8KiB", utf8_paste(8 * 1024)),
        // Worst case for a per-match search: coloured log output, an ESC
        // every eight bytes.
        ("ansi-esc-every-8-8KiB", source_paste(8 * 1024, Some(8))),
        ("ascii-source-63KiB", source_paste(63 * 1024, None)),
        ("short-command-120B", source_paste(120, None)),
    ];
    println!(
        "{:<28} {:>12} {:>12} {:>12} {:>12} {:>12} {:>12} {:>10}",
        "case",
        "prod p50 ns",
        "prod p95 ns",
        "split p50 ns",
        "split p95 ns",
        "memchr p50",
        "memchr p95",
        "decode ns"
    );
    for (name, text) in cases {
        let record = build::paste(&text);
        let decoded = input_record::decode(&record).expect("paste record");
        let mut production = Vec::with_capacity(record.len() + 12);
        let mut candidate = Vec::with_capacity(record.len() + 12);
        let mut simd = Vec::with_capacity(record.len() + 12);
        input_encoder::encode(&decoded, mode, &mut production);
        let InputRecord::Paste(paste) = decoded else {
            panic!("paste");
        };
        candidate_encode_paste(paste, mode, &mut candidate);
        memchr_encode_paste(paste, mode, &mut simd);
        assert_eq!(production, candidate, "{name}: str split changed the bytes");
        assert_eq!(production, simd, "{name}: memchr changed the bytes");
        // Unbracketed mode is a single copy on every arm.
        let (mut plain_a, mut plain_b, mut plain_c) = (Vec::new(), Vec::new(), Vec::new());
        input_encoder::encode(&decoded, TermMode::empty(), &mut plain_a);
        candidate_encode_paste(paste, TermMode::empty(), &mut plain_b);
        memchr_encode_paste(paste, TermMode::empty(), &mut plain_c);
        assert_eq!(plain_a, plain_b);
        assert_eq!(plain_a, plain_c);

        let run = |arm: PasteArm, out: &mut Vec<u8>| {
            let started = Instant::now();
            for _ in 0..reps {
                out.clear();
                match arm {
                    PasteArm::Production => {
                        input_encoder::encode(std::hint::black_box(&decoded), mode, out);
                    }
                    PasteArm::StrSplit => {
                        candidate_encode_paste(std::hint::black_box(paste), mode, out);
                    }
                    PasteArm::Memchr => {
                        memchr_encode_paste(std::hint::black_box(paste), mode, out);
                    }
                }
                std::hint::black_box(&out);
            }
            started.elapsed().as_nanos() as f64 / reps as f64
        };
        for _ in 0..16 {
            run(PasteArm::Production, &mut production);
            run(PasteArm::StrSplit, &mut candidate);
            run(PasteArm::Memchr, &mut simd);
        }
        let mut prod_samples = Vec::with_capacity(samples);
        let mut cand_samples = Vec::with_capacity(samples);
        let mut simd_samples = Vec::with_capacity(samples);
        for sample in 0..samples {
            for arm in PASTE_ARM_ORDERS[sample % PASTE_ARM_ORDERS.len()] {
                match arm {
                    PasteArm::Production => prod_samples.push(run(arm, &mut production)),
                    PasteArm::StrSplit => cand_samples.push(run(arm, &mut candidate)),
                    PasteArm::Memchr => simd_samples.push(run(arm, &mut simd)),
                }
            }
        }
        let (prod_p50, prod_p95) = summarize(
            &format!("daemon-io-paste-encode-{name}-production"),
            &mut prod_samples,
            "ns/entry",
        );
        let (cand_p50, cand_p95) = summarize(
            &format!("daemon-io-paste-encode-{name}-candidate"),
            &mut cand_samples,
            "ns/entry",
        );
        let (simd_p50, simd_p95) = summarize(
            &format!("daemon-io-paste-encode-{name}-memchr"),
            &mut simd_samples,
            "ns/entry",
        );
        // Record validation is paid twice per entry today (run parse, then
        // admission decode); time one decode for scale.
        let mut decode_samples = Vec::with_capacity(samples);
        for _ in 0..samples {
            let started = Instant::now();
            for _ in 0..reps {
                std::hint::black_box(input_record::decode(std::hint::black_box(&record)));
            }
            decode_samples.push(started.elapsed().as_nanos() as f64 / reps as f64);
        }
        let (decode_p50, _) = summarize(
            &format!("daemon-io-paste-decode-{name}"),
            &mut decode_samples,
            "ns/entry",
        );
        println!(
            "{:<28} {:>12.1} {:>12.1} {:>12.1} {:>12.1} {:>12.1} {:>12.1} {:>10.1}",
            name, prod_p50, prod_p95, cand_p50, cand_p95, simd_p50, simd_p95, decode_p50
        );
    }
}

// ---------------------------------------------------------------------------
// Input-ack / heartbeat datagram send on real carriers
// ---------------------------------------------------------------------------

/// The wire `send_input_ack` / the heartbeat seal: `[channel][sealed]` as one
/// immutable owner, which both carriers queue without copying.
fn ack_wire(round: u32, index: u32, sealed_len: usize) -> bytes::Bytes {
    let mut wire = vec![0x5a; 1 + sealed_len];
    wire[0] = CHANNEL_PTY;
    wire[1] = 0xA0;
    wire[2..6].copy_from_slice(&round.to_be_bytes());
    wire[6..10].copy_from_slice(&index.to_be_bytes());
    bytes::Bytes::from(wire)
}

struct CarrierFixture {
    transport: PeerTransport,
    direct: Option<DirectSession>,
    edge: Option<Arc<EdgeTunnel>>,
    received: mpsc::UnboundedReceiver<bytes::Bytes>,
    /// Bytes the browser side has read from reliable streams.
    stream_bytes: Arc<AtomicUsize>,
    _keep: Vec<Box<dyn std::any::Any + Send>>,
}

/// Browser side of one carrier: every datagram is forwarded for comparison and
/// every unidirectional stream is drained, counting its bytes.
async fn run_browser_side(
    conn: wtransport::Connection,
    datagrams: mpsc::UnboundedSender<bytes::Bytes>,
    stream_bytes: Arc<AtomicUsize>,
) {
    loop {
        tokio::select! {
            datagram = conn.receive_datagram() => {
                let Ok(datagram) = datagram else { break };
                if datagrams.send(datagram.payload()).is_err() {
                    break;
                }
            }
            stream = conn.accept_uni() => {
                let Ok(mut stream) = stream else { break };
                let counter = Arc::clone(&stream_bytes);
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 64 * 1024];
                    while let Ok(Some(read)) = stream.read(&mut buffer).await {
                        counter.fetch_add(read, Ordering::AcqRel);
                    }
                });
            }
        }
    }
}

async fn edge_fixture() -> CarrierFixture {
    let (config, cert) = webtransport::build_server_config(0).expect("server config");
    let server = Endpoint::server(config).expect("server");
    let url = format!(
        "https://127.0.0.1:{}",
        server.local_addr().expect("addr").port()
    );
    let (received_tx, received) = mpsc::unbounded_channel();
    let stream_bytes = Arc::new(AtomicUsize::new(0));
    let browser_bytes = Arc::clone(&stream_bytes);
    let server_task = tokio::spawn(async move {
        let conn = server
            .accept()
            .await
            .await
            .expect("request")
            .accept()
            .await
            .expect("accept");
        let (mut lifecycle, mut routing) = conn.accept_bi().await.expect("routing stream");
        let mut length = [0; 4];
        routing
            .read_exact(&mut length)
            .await
            .expect("routing header");
        let mut body = vec![0; u32::from_be_bytes(length) as usize];
        routing.read_exact(&mut body).await.expect("routing body");
        let (quote_send, mut quote_recv) = conn.accept_bi().await.expect("quote stream");
        let mut preface = [0; b"merkur-edge-quote-v1".len()];
        quote_recv
            .read_exact(&mut preface)
            .await
            .expect("quote preface");
        let present =
            br#"{"type":"counterpart_present","present":true,"counterpart_attachment_id":1}"#;
        lifecycle
            .write_all(&(present.len() as u32).to_be_bytes())
            .await
            .expect("lifecycle header");
        lifecycle.write_all(present).await.expect("lifecycle body");
        run_browser_side(conn, received_tx, browser_bytes).await;
        drop((lifecycle, routing, quote_send, quote_recv, server));
    });
    let credential = crate::edge_tunnel::EdgeAdmission::for_test()
        .current()
        .expect("test credential");
    let tunnel = EdgeTunnel::connect(&url, &[cert.cert_hash], "profile", EdgeLane::Interactive, &wtransport::quinn::ProbeGroup::new(), &credential)
        .await
        .expect("edge tunnel");
    let tunnel = Arc::new(tunnel);
    let mut changes = tunnel.counterpart_changes();
    // Wait on the states that are not a pairing, so the loop does not depend on
    // what `Attached` carries.
    while matches!(
        tunnel.counterpart_state(),
        CounterpartState::Pending | CounterpartState::Detached { .. }
    ) {
        changes.changed().await.expect("counterpart watch");
    }
    CarrierFixture {
        transport: PeerTransport::Edge,
        direct: None,
        edge: Some(tunnel),
        received,
        stream_bytes,
        _keep: vec![Box::new(server_task)],
    }
}

async fn direct_fixture() -> CarrierFixture {
    let (config, cert) = webtransport::build_server_config(0).expect("server config");
    let server = Endpoint::server(config).expect("server");
    let url = format!(
        "https://127.0.0.1:{}",
        server.local_addr().expect("addr").port()
    );
    let client = Endpoint::client(
        ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([Sha256Digest::new(cert.cert_hash)])
            .build(),
    )
    .expect("client");
    let (daemon_side, browser_side) = tokio::join!(
        async {
            server
                .accept()
                .await
                .await
                .expect("request")
                .accept()
                .await
                .expect("accept")
        },
        client.connect(&url)
    );
    let browser_side = browser_side.expect("browser connection");
    let (received_tx, received) = mpsc::unbounded_channel();
    let stream_bytes = Arc::new(AtomicUsize::new(0));
    let browser_bytes = Arc::clone(&stream_bytes);
    let browser_task = tokio::spawn(async move {
        run_browser_side(browser_side, received_tx, browser_bytes).await;
        drop(client);
    });
    // The production reliable send task on a real stream, fed by the PTY
    // channel sender the peer's direct session holds.
    let pty_stream = daemon_side
        .open_uni()
        .await
        .expect("open uni")
        .await
        .expect("uni stream");
    let (pty, pty_rx) = mpsc::channel(256);
    let send_task = crate::network::peer::spawn_send_task(pty_stream, pty_rx);
    let (ctrl, _ctrl_rx) = mpsc::channel(1);
    let (display_commit, _display_commit_rx) = mpsc::channel(1);
    let direct = DirectSession::new(
        Arc::new(daemon_side),
        crate::network::peer::ChannelSenders {
            ctrl,
            pty,
            display_commit,
            signaling: None,
        },
    );
    CarrierFixture {
        transport: PeerTransport::WebTransport,
        direct: Some(direct),
        edge: None,
        received,
        stream_bytes,
        _keep: vec![
            Box::new(browser_task),
            Box::new(server),
            Box::new(send_task),
            Box::new(_ctrl_rx),
            Box::new(_display_commit_rx),
        ],
    }
}

#[derive(Default)]
struct SendTally {
    sends: usize,
    refused: usize,
    allocations: usize,
    allocated_bytes: usize,
    ns: Vec<f64>,
}

async fn profile_datagrams(label: &str, fixture: &mut CarrierFixture) {
    let rounds = env_usize("BENCH_ROUNDS", 64) as u32;
    let batch = 32u32;
    let sealed_len = env_usize("BENCH_SEALED_BYTES", 32);
    let mut tally = SendTally::default();
    let mut process = (0usize, 0usize);
    for round in 0..rounds + 2 {
        let warm = round < 2;
        // Sealing is outside the window: it has its own pool and its own test.
        let wires: Vec<bytes::Bytes> = (0..batch)
            .map(|index| ack_wire(round, index, sealed_len))
            .collect();
        if !warm {
            test_allocations::begin();
        }
        for wire in &wires {
            test_allocations::begin_thread();
            let started = Instant::now();
            let sent = crate::transport::transport_send_datagram(
                fixture.transport,
                wire,
                fixture.direct.as_ref(),
                fixture.edge.as_ref(),
            );
            let elapsed = started.elapsed().as_nanos() as f64;
            let caller = test_allocations::end_thread();
            if warm {
                continue;
            }
            tally.sends += 1;
            tally.refused += usize::from(!sent);
            tally.allocations += caller.allocations;
            tally.allocated_bytes += caller.allocated_bytes;
            tally.ns.push(elapsed);
        }
        // Receipt proves the carrier accepted and delivered each frame
        // byte-for-byte; waiting also keeps the bounded queue from filling.
        for want in &wires {
            let got = tokio::time::timeout(Duration::from_secs(5), fixture.received.recv())
                .await
                .expect("datagram delivered within 5 s on loopback")
                .expect("receiver alive");
            assert_eq!(got, want, "{label}: payload differs");
        }
        if !warm {
            let all = test_allocations::end();
            process.0 += all.allocations;
            process.1 += batch as usize;
        }
    }
    let name = format!("daemon-io-{label}-ack-datagram");
    let (p50, p95) = summarize(&name, &mut tally.ns, "ns/send");
    let sends = tally.sends as f64;
    count_metric(
        &format!("{name}-caller-allocations"),
        tally.allocations as f64 / sends,
        "allocations/send",
        tally.sends,
    );
    count_metric(
        &format!("{name}-process-allocations"),
        process.0 as f64 / process.1 as f64,
        "allocations/send",
        process.1,
    );
    println!(
        "{:<8} {:>6} {:>7} {:>11} {:>11} {:>12} {:>9} {:>9}",
        "carrier",
        "sends",
        "refused",
        "caller a/s",
        "caller B/s",
        "process a/s",
        "p50 ns",
        "p95 ns"
    );
    println!(
        "{:<8} {:>6} {:>7} {:>11.3} {:>11.1} {:>12.3} {:>9.0} {:>9.0}",
        label,
        tally.sends,
        tally.refused,
        tally.allocations as f64 / sends,
        tally.allocated_bytes as f64 / sends,
        process.0 as f64 / process.1 as f64,
        p50,
        p95
    );
}

/// The reliable twin of every input ack: an inline sealed record admitted on
/// the arrival carrier through `transport_send_reliable_with_fallback`, then
/// written by the carrier's reliable writer (the edge lane writer, or the
/// direct `spawn_send_task` / `write_send_batch`).
async fn profile_reliable_twin(label: &str, fixture: &CarrierFixture) {
    let rounds = env_usize("BENCH_ROUNDS", 64);
    let batch = 32usize;
    let mut paths = crate::connection::PeerPaths::new(fixture.transport, 0.0);
    let mut caller = (0usize, 0usize, 0usize, 0usize);
    let mut process = (0usize, 0usize);
    let mut ns = Vec::with_capacity(rounds * batch);
    for round in 0..rounds + 2 {
        let warm = round < 2;
        let before = fixture.stream_bytes.load(Ordering::Acquire);
        if !warm {
            test_allocations::begin();
        }
        for index in 0..batch {
            let mut sealed = [0x3cu8; INLINE_RELIABLE_PAYLOAD_BYTES];
            sealed[..4].copy_from_slice(&(index as u32).to_be_bytes());
            test_allocations::begin_thread();
            let started = Instant::now();
            let accepted = crate::transport::transport_send_reliable_with_fallback(
                &mut paths,
                fixture.transport,
                CHANNEL_PTY,
                ReliablePayload::inline(INLINE_RELIABLE_PAYLOAD_BYTES, sealed),
                fixture.direct.as_ref(),
                fixture.edge.as_ref(),
                0.0,
            );
            let elapsed = started.elapsed().as_nanos() as f64;
            let tally = test_allocations::end_thread();
            if warm {
                continue;
            }
            caller.0 += 1;
            caller.1 += usize::from(accepted != Some(fixture.transport));
            caller.2 += tally.allocations;
            caller.3 += tally.allocated_bytes;
            ns.push(elapsed);
        }
        // Every record is `[u32 len][32 sealed bytes]` on the wire; wait until
        // the browser side has read all of them so the writer's work is inside
        // the process-wide count.
        let want = before + batch * (4 + INLINE_RELIABLE_PAYLOAD_BYTES);
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.stream_bytes.load(Ordering::Acquire) < want {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("reliable records drained within 5 s on loopback");
        if !warm {
            let all = test_allocations::end();
            process.0 += all.allocations;
            process.1 += batch;
        }
    }
    let name = format!("daemon-io-{label}-ack-reliable-twin");
    let (p50, p95) = summarize(&name, &mut ns, "ns/send");
    count_metric(
        &format!("{name}-caller-allocations"),
        caller.2 as f64 / caller.0 as f64,
        "allocations/send",
        caller.0,
    );
    count_metric(
        &format!("{name}-process-allocations"),
        process.0 as f64 / process.1 as f64,
        "allocations/send",
        process.1,
    );
    println!(
        "{:<8} {:<11} {:>6} {:>7} {:>11.3} {:>11.1} {:>12.3} {:>9.0} {:>9.0}",
        label,
        "ReliableAck",
        caller.0,
        caller.1,
        caller.2 as f64 / caller.0 as f64,
        caller.3 as f64 / caller.0 as f64,
        process.0 as f64 / process.1 as f64,
        p50,
        p95
    );
}

#[test]
#[ignore = "daemon-io datagram send profile over real loopback QUIC"]
fn ack_datagram_send_profile() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("runtime");
    // The caller thread drives the send exactly as the owner loop does; the
    // QUIC drivers and carrier writers run on the runtime workers.
    runtime.block_on(async {
        let mut edge = edge_fixture().await;
        profile_datagrams("edge", &mut edge).await;
        profile_reliable_twin("edge", &edge).await;
        let mut direct = direct_fixture().await;
        profile_datagrams("direct", &mut direct).await;
        profile_reliable_twin("direct", &direct).await;
    });
}

// ---------------------------------------------------------------------------
// Per-keystroke profiling hooks
// ---------------------------------------------------------------------------

fn stamps(at: Instant) -> DisplaySendStamps {
    DisplaySendStamps {
        flush_started_at: at,
        selection_finished_at: at,
        prepare_queued_at: at,
        prepare_started_at: at,
        prepare_finished_at: at,
        completion_started_at: at,
        sent_at: at,
        compression_time: Duration::ZERO,
        presentation_end_admitted: true,
        flush_owner: Default::default(),
        sent_owner: Default::default(),
    }
}

/// The hooks the owner loop runs per keystroke while a browser profiles:
/// receive, trace-token lookup, FIFO enqueue, read, grid apply, display send.
/// `backlog` unanswered inputs model a password prompt or an application that
/// ignores the input (no read ever answers them).
#[test]
#[ignore = "daemon-io perf-timing hook profile"]
fn perf_timing_keystroke_hooks_profile() {
    let samples = env_usize("BENCH_SAMPLES", 400);
    let reps = 64u32;
    println!(
        "{:<10} {:>14} {:>14} {:>14} {:>12}",
        "backlog", "cycle p50 ns", "cycle p95 ns", "token p50 ns", "allocs/cycle"
    );
    for backlog in [0u32, 64, 255] {
        let mut tracker = PerfTimingTracker::default();
        tracker.configure(Arc::from("perf-peer"), "perf-session", true, 1);
        let base = Instant::now();
        let mut seq = 1u32;
        for _ in 0..backlog {
            tracker.note_input_received_owned(seq, base);
            tracker.note_pty_write_owned(seq, base);
            seq += 1;
        }
        // Unanswered backlog: stamp a read that predates nothing new.
        let cycle = |tracker: &mut PerfTimingTracker, seq: &mut u32| {
            let now = Instant::now();
            let s = *seq;
            tracker.note_input_received_owned(s, now);
            std::hint::black_box(tracker.trace_token_for_pending_input(s));
            tracker.note_pty_write_owned(s, now);
            if backlog == 0 {
                tracker.note_pty_read(now);
                tracker.note_grid_applied(now);
                tracker.note_display_sent_for("perf-peer", "perf-session", s, stamps(now));
            } else {
                // The backlog never completes; retire only the newest input as
                // a release that wrote nothing, so the depth stays constant.
                tracker.note_input_silent_owned(s);
            }
            if let Some(batch) = tracker.take_due_wire_batch(now + Duration::from_secs(1)) {
                tracker.accept_wire_batch(&batch, now);
            }
            *seq = seq.wrapping_add(1);
        };
        for _ in 0..1024 {
            cycle(&mut tracker, &mut seq);
        }
        test_allocations::begin_thread();
        for _ in 0..1024 {
            cycle(&mut tracker, &mut seq);
        }
        let allocations = test_allocations::end_thread();
        let mut cycle_samples = Vec::with_capacity(samples);
        let mut token_samples = Vec::with_capacity(samples);
        for _ in 0..samples {
            let started = Instant::now();
            for _ in 0..reps {
                cycle(&mut tracker, &mut seq);
            }
            cycle_samples.push(started.elapsed().as_nanos() as f64 / f64::from(reps));
            let newest = seq.wrapping_sub(1);
            tracker.note_input_received_owned(seq, Instant::now());
            let started = Instant::now();
            for _ in 0..reps {
                std::hint::black_box(tracker.trace_token_for_pending_input(seq));
            }
            token_samples.push(started.elapsed().as_nanos() as f64 / f64::from(reps));
            tracker.note_input_silent_owned(seq);
            std::hint::black_box(newest);
        }
        let (cycle_p50, cycle_p95) = summarize(
            &format!("daemon-io-perf-timing-cycle-backlog-{backlog}"),
            &mut cycle_samples,
            "ns/keystroke",
        );
        let (token_p50, _) = summarize(
            &format!("daemon-io-perf-timing-trace-token-backlog-{backlog}"),
            &mut token_samples,
            "ns/lookup",
        );
        println!(
            "{:<10} {:>14.1} {:>14.1} {:>14.1} {:>12.3}",
            backlog,
            cycle_p50,
            cycle_p95,
            token_p50,
            allocations.allocations as f64 / 1024.0
        );
        tracker.clear_owner();
    }
}

// ---------------------------------------------------------------------------
// Row capture of OSC 8 links the browser refuses
// ---------------------------------------------------------------------------

const LINK_COLS: u16 = 120;
const LINK_ROWS: u16 = 40;
const LINKS_PER_ROW: usize = 8;

/// One screen in the shape `ls --hyperlink` (GNU ls, eza, fd) prints: every
/// file name is its own OSC 8 region naming an absolute `file://host/path`.
/// `scheme` is `None` for the same text without links. `tag` changes every
/// name, so alternating two screens redraws every row with new regions.
fn osc8_listing(scheme: Option<&str>, tag: char) -> Vec<u8> {
    let mut screen = Vec::new();
    for row in 0..LINK_ROWS {
        screen.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
        for index in 0..LINKS_PER_ROW {
            let name = format!("{tag}_session_{row:02}_{index}.rs");
            if let Some(scheme) = scheme {
                screen.extend_from_slice(
                    format!(
                        "\x1b]8;;{scheme}//box.local/home/user/projects/merkur/apps/daemon/dataplane/src/pty/{name}\x1b\\"
                    )
                    .as_bytes(),
                );
            }
            screen.extend_from_slice(name.as_bytes());
            if scheme.is_some() {
                screen.extend_from_slice(b"\x1b]8;;\x1b\\");
            }
            screen.extend_from_slice(b"  ");
        }
    }
    screen
}

/// Proposed: refuse a non-web scheme before the URI is hashed or scanned. A
/// URI the table knows was vetted, and vetting requires this prefix, so a URI
/// without it can only ever intern to 0: the result is unchanged.
fn candidate_intern(table: &mut crate::pty::links::LinkTable, link: &Hyperlink) -> u32 {
    let uri = link.uri().as_bytes();
    let web = |prefix: &[u8]| {
        uri.len() > prefix.len() && uri[..prefix.len()].eq_ignore_ascii_case(prefix)
    };
    if !web(b"http://") && !web(b"https://") {
        return 0;
    }
    table.intern(link)
}

/// Capture cost of a full-screen redraw of `ls --hyperlink`-style output
/// against the same text plain and with web links, through the production
/// `TerminalState::update_hashes_for_dirty_rows`; then the per-region
/// `LinkTable::intern` cost of a refused link, production against the
/// scheme-first candidate, ABBA in one process.
#[test]
#[ignore = "daemon-io refused link capture profile"]
fn refused_link_capture_profile() {
    let samples = env_usize("BENCH_SAMPLES", 300);
    println!(
        "{:<14} {:>14} {:>14} {:>14} {:>16}",
        "screen", "apply p50 ms", "capture p50 ms", "capture p95 ms", "capture allocs"
    );
    for (name, scheme) in [
        ("plain", None),
        ("file-links", Some("file:")),
        ("https-links", Some("https:")),
    ] {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = crate::pty::TerminalState::new(LINK_COLS, LINK_ROWS, event_tx);
        let screens = [osc8_listing(scheme, 'a'), osc8_listing(scheme, 'b')];
        let mut hashes = Vec::new();
        let mut captures = Vec::new();
        for sample in 0..32 {
            terminal.apply_bytes(&screens[sample & 1]);
            terminal.update_hashes_for_dirty_rows(&mut hashes, &mut captures);
        }
        let mut apply = Vec::with_capacity(samples);
        let mut capture = Vec::with_capacity(samples);
        let mut allocations = 0usize;
        let mut rows = 0usize;
        for sample in 0..samples {
            let started = Instant::now();
            terminal.apply_bytes(&screens[sample & 1]);
            apply.push(started.elapsed().as_secs_f64() * 1_000.0);
            test_allocations::begin_thread();
            let started = Instant::now();
            terminal.update_hashes_for_dirty_rows(&mut hashes, &mut captures);
            capture.push(started.elapsed().as_secs_f64() * 1_000.0);
            allocations += test_allocations::end_thread().allocations;
            rows += captures.len();
        }
        assert_eq!(rows, samples * usize::from(LINK_ROWS), "every row redraws");
        let (apply_p50, _) = summarize(
            &format!("daemon-io-link-capture-{name}-apply"),
            &mut apply,
            "ms/screen",
        );
        let (capture_p50, capture_p95) = summarize(
            &format!("daemon-io-link-capture-{name}-capture"),
            &mut capture,
            "ms/screen",
        );
        println!(
            "{:<14} {:>14.4} {:>14.4} {:>14.4} {:>16.1}",
            name,
            apply_p50,
            capture_p50,
            capture_p95,
            allocations as f64 / samples as f64
        );
    }

    // One refused region per call, as `fill_visible_cells` interns it: every
    // region of a redraw is a fresh allocation.
    let reps = env_usize("BENCH_REPS", 8);
    let regions: Vec<Hyperlink> = (0..LINK_ROWS as usize * LINKS_PER_ROW)
        .map(|index| {
            Hyperlink::new(
                None::<String>,
                format!(
                    "file://box.local/home/user/projects/merkur/apps/daemon/dataplane/src/pty/a_session_{index:03}.rs"
                ),
            )
        })
        .collect();
    let mut table = crate::pty::links::LinkTable::default();
    for region in &regions {
        assert_eq!(table.intern(region), 0);
        assert_eq!(candidate_intern(&mut table, region), 0);
    }
    for uri in [
        "https://a.example/x",
        "HTTP://b.example/",
        "https://",
        "http:/x",
        "file:///etc/hosts",
    ] {
        let region = Hyperlink::new(None::<String>, uri.to_owned());
        let mut expected_table = crate::pty::links::LinkTable::default();
        let mut candidate_table = crate::pty::links::LinkTable::default();
        assert_eq!(
            expected_table.intern(&region),
            candidate_intern(&mut candidate_table, &region),
            "{uri}"
        );
    }
    let run_production = |table: &mut crate::pty::links::LinkTable| {
        let started = Instant::now();
        for _ in 0..reps {
            for region in &regions {
                std::hint::black_box(table.intern(std::hint::black_box(region)));
            }
        }
        started.elapsed().as_nanos() as f64 / (reps * regions.len()) as f64
    };
    let run_candidate = |table: &mut crate::pty::links::LinkTable| {
        let started = Instant::now();
        for _ in 0..reps {
            for region in &regions {
                std::hint::black_box(candidate_intern(table, std::hint::black_box(region)));
            }
        }
        started.elapsed().as_nanos() as f64 / (reps * regions.len()) as f64
    };
    for _ in 0..16 {
        run_production(&mut table);
        run_candidate(&mut table);
    }
    let (mut production, mut candidate) = (Vec::new(), Vec::new());
    for sample in 0..samples {
        if matches!(sample % 4, 0 | 3) {
            production.push(run_production(&mut table));
            candidate.push(run_candidate(&mut table));
        } else {
            candidate.push(run_candidate(&mut table));
            production.push(run_production(&mut table));
        }
    }
    let (production_p50, production_p95) = summarize(
        "daemon-io-refused-link-intern-production",
        &mut production,
        "ns/region",
    );
    let (candidate_p50, candidate_p95) = summarize(
        "daemon-io-refused-link-intern-candidate",
        &mut candidate,
        "ns/region",
    );
    println!(
        "refused region intern: production p50/p95 {production_p50:.1}/{production_p95:.1} ns, scheme-first candidate {candidate_p50:.1}/{candidate_p95:.1} ns ({} regions x {reps} reps x {samples} samples)",
        regions.len()
    );
    assert!(
        table.live().is_empty(),
        "a refused link never enters the table"
    );
}
