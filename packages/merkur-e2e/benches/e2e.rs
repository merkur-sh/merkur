//! Native ceiling for the E2E transport, mirroring `scripts/bench-e2e-crypto.ts`
//! workload-for-workload. The TypeScript arm measures the same operations at the
//! same frame sizes, so the two reports bound what the WebAssembly arm can reach:
//! WASM lands between this and the JavaScript number.

use criterion::{BatchSize, Criterion, Throughput, criterion_group, criterion_main};
use merkur_e2e::{
    NoiseHandshake, NoiseTransport, derive_prologue, generate_static_keypair, lane_for_channel,
};
use std::hint::black_box;

const SMALL_PAYLOAD_BYTES: usize = 32;
const LARGE_PAYLOAD_BYTES: usize = 8 * 1024;
const BATCH_SIZE: usize = 256;

const CHANNEL_PTY: u8 = 0x01;
const CHANNEL_DISPLAY_DATAGRAM: u8 = 0x03;
const CHANNEL_DISPLAY_COMMIT: u8 = 0x04;

fn established_pair() -> (NoiseTransport, NoiseTransport) {
    let psk = [7u8; 32];
    let prologue = derive_prologue("bench-session", "bench-daemon", &[0x42; 64]);
    let (initiator_static, _) = generate_static_keypair().expect("initiator static keypair");
    let (responder_static, _) = generate_static_keypair().expect("responder static keypair");
    let mut initiator =
        NoiseHandshake::new_initiator(&initiator_static, &psk, &prologue).expect("initiator");
    let mut responder =
        NoiseHandshake::new_responder(&responder_static, &psk, &prologue).expect("responder");

    let msg1 = initiator.write_message(&[]).expect("msg1");
    responder.read_message(&msg1).expect("read msg1");
    let msg2 = responder.write_message(&[]).expect("msg2");
    initiator.read_message(&msg2).expect("read msg2");
    let msg3 = initiator.write_message(&[]).expect("msg3");
    responder.read_message(&msg3).expect("read msg3");

    (
        initiator.into_transport().expect("initiator transport"),
        responder.into_transport().expect("responder transport"),
    )
}

fn payloads(count: usize, byte_length: usize) -> Vec<Vec<u8>> {
    (0..count)
        .map(|index| {
            (0..byte_length)
                .map(|offset| (index * 31 + offset * 17 + byte_length) as u8)
                .collect()
        })
        .collect()
}

/// Same LCG-driven Fisher-Yates as the TypeScript arm, so both see one arrival
/// order and the replay window takes the same branch mix.
fn deterministic_shuffle(count: usize) -> Vec<usize> {
    let mut order: Vec<usize> = (0..count).collect();
    let mut state: u32 = 0x2545_f491;
    for index in (1..count).rev() {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let target = (state as usize) % (index + 1);
        order.swap(index, target);
    }
    order
}

fn seal_open(criterion: &mut Criterion) {
    let cases: [(&str, u8, bool, usize, bool); 3] = [
        (
            "datagram-small",
            CHANNEL_PTY,
            true,
            SMALL_PAYLOAD_BYTES,
            false,
        ),
        (
            "stream-large",
            CHANNEL_DISPLAY_COMMIT,
            false,
            LARGE_PAYLOAD_BYTES,
            false,
        ),
        (
            "datagram-reorder",
            CHANNEL_DISPLAY_DATAGRAM,
            true,
            SMALL_PAYLOAD_BYTES,
            true,
        ),
    ];

    for (name, channel_id, datagram, payload_bytes, reorder) in cases {
        let lane = lane_for_channel(channel_id).expect("bench channel has a lane");
        let batch = payloads(BATCH_SIZE, payload_bytes);
        let order = deterministic_shuffle(BATCH_SIZE);

        let mut group = criterion.benchmark_group(name);
        group.throughput(Throughput::Bytes((BATCH_SIZE * payload_bytes) as u64));

        group.bench_function("seal", |bencher| {
            let (mut sender, _receiver) = established_pair();
            bencher.iter(|| {
                for payload in &batch {
                    let framed = if datagram {
                        sender.seal_datagram(lane, payload)
                    } else {
                        sender.seal_stream(lane, payload)
                    };
                    black_box(framed.expect("seal"));
                }
            });
        });

        group.bench_function("open", |bencher| {
            // Each iteration needs a receiver that has never seen these counters:
            // a replayed counter is rejected by design and would measure the
            // reject path instead of the decrypt path. `NoiseTransport` is not
            // `Clone`, so the untimed setup builds a fresh pair every iteration.
            bencher.iter_batched(
                || {
                    let (mut sender, receiver) = established_pair();
                    let framed: Vec<Vec<u8>> = batch
                        .iter()
                        .map(|payload| {
                            if datagram {
                                sender.seal_datagram(lane, payload).expect("seal")
                            } else {
                                sender.seal_stream(lane, payload).expect("seal")
                            }
                        })
                        .collect();
                    (receiver, framed)
                },
                |(mut receiver, framed)| {
                    for (step, slot) in framed.iter().enumerate() {
                        let frame = if reorder { &framed[order[step]] } else { slot };
                        let plaintext = if datagram {
                            receiver.open_datagram(lane, frame)
                        } else {
                            receiver.open_stream(lane, frame)
                        };
                        black_box(plaintext.expect("open"));
                    }
                },
                BatchSize::SmallInput,
            );
        });

        group.finish();
    }
}

fn handshake(criterion: &mut Criterion) {
    criterion.bench_function("handshake", |bencher| {
        bencher.iter(|| black_box(established_pair()));
    });
}

criterion_group!(benches, seal_open, handshake);
criterion_main!(benches);
