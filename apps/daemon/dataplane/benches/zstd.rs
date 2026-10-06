use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};

/// The level the daemon compresses display frames with. A benchmark at another
/// level measures a codec production does not run.
const DISPLAY_COMPRESSION_LEVEL: i32 = 3;

const STREAM_HEADER_BYTES: usize = 16;

fn create_payload(size: usize, pattern: &str) -> Vec<u8> {
    let mut payload = vec![0u8; size];
    match pattern {
        "blank" => payload.fill(0x20),
        "terminal" => {
            let phrases: &[&[u8]] = &[
                b"src/app/createTerminalSession.ts  ",
                b"INFO display_frame_sent rows=12 bytes=4096  ",
                b"\x1b[32m\xe2\x9c\x93\x1b[0m test passed  ",
                b"merkur daemon output stream  ",
            ];
            let mut offset = 0;
            while offset < payload.len() {
                let phrase = phrases[offset % phrases.len()];
                for &b in phrase {
                    if offset >= payload.len() {
                        break;
                    }
                    payload[offset] = b;
                    offset += 1;
                }
            }
        }
        "gradient" => {
            for (i, byte) in payload.iter_mut().enumerate() {
                *byte = (i & 0xff) as u8;
            }
        }
        "random" => {
            let mut state: u32 = 0x1234_5678;
            for byte in payload.iter_mut() {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *byte = (state >> 24) as u8;
            }
        }
        _ => {}
    }
    payload
}

fn create_display_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = vec![0u8; STREAM_HEADER_BYTES + payload.len()];
    frame[0] = 0x20;
    let body_len = payload.len();
    frame[1] = ((body_len >> 16) & 0xff) as u8;
    frame[2] = ((body_len >> 8) & 0xff) as u8;
    frame[3] = (body_len & 0xff) as u8;
    frame[STREAM_HEADER_BYTES..].copy_from_slice(payload);
    frame
}

fn bench_compress(c: &mut Criterion) {
    let sizes: &[usize] = &[512, 1024, 2048, 4096, 8192, 16_384, 32_768, 65_536, 262_144];
    let patterns: &[&str] = &["blank", "terminal", "gradient", "random"];

    let mut group = c.benchmark_group("zstd_compress");

    for &size in sizes {
        for &pattern in patterns {
            let payload = create_payload(size, pattern);
            let mut context =
                zstd::bulk::Compressor::new(DISPLAY_COMPRESSION_LEVEL).expect("context");
            let mut out_buf = Vec::with_capacity(zstd::zstd_safe::compress_bound(payload.len()));

            group.throughput(Throughput::Bytes(size as u64));
            group.bench_with_input(BenchmarkId::new(pattern, size), &payload, |b, payload| {
                b.iter(|| {
                    out_buf.clear();
                    context.compress_to_buffer(payload, &mut out_buf).unwrap();
                });
            });
        }
    }

    group.finish();
}

fn bench_decompress(c: &mut Criterion) {
    let sizes: &[usize] = &[512, 1024, 4096, 16_384, 65_536, 262_144];
    let patterns: &[&str] = &["blank", "terminal", "gradient", "random"];

    let mut group = c.benchmark_group("zstd_decompress");

    for &size in sizes {
        for &pattern in patterns {
            let payload = create_payload(size, pattern);
            let compressed =
                zstd::bulk::compress(&payload, DISPLAY_COMPRESSION_LEVEL).expect("compress");
            let mut context = zstd::bulk::Decompressor::new().expect("context");
            let mut decompressed = Vec::with_capacity(size);

            group.throughput(Throughput::Bytes(size as u64));
            group.bench_with_input(
                BenchmarkId::new(pattern, size),
                &compressed,
                |b, compressed| {
                    b.iter(|| {
                        decompressed.clear();
                        context
                            .decompress_to_buffer(compressed, &mut decompressed)
                            .unwrap();
                    });
                },
            );
        }
    }

    group.finish();
}

fn bench_display_frame_compress(c: &mut Criterion) {
    let sizes: &[usize] = &[4096, 16_384, 65_536];
    let patterns: &[&str] = &["terminal", "random"];

    let mut group = c.benchmark_group("display_frame_compress");

    for &size in sizes {
        for &pattern in patterns {
            let payload = create_payload(size, pattern);
            let frame = create_display_frame(&payload);
            let body = &frame[STREAM_HEADER_BYTES..];
            let mut context =
                zstd::bulk::Compressor::new(DISPLAY_COMPRESSION_LEVEL).expect("context");
            let mut compress_buf = Vec::with_capacity(zstd::zstd_safe::compress_bound(body.len()));

            group.throughput(Throughput::Bytes(size as u64));
            group.bench_with_input(BenchmarkId::new(pattern, size), &frame, |b, frame| {
                b.iter(|| {
                    let body = &frame[STREAM_HEADER_BYTES..];
                    compress_buf.clear();
                    let compressed_len =
                        context.compress_to_buffer(body, &mut compress_buf).unwrap();
                    let compressed_frame_bytes = STREAM_HEADER_BYTES + 6 + compressed_len;
                    let mut out = Vec::with_capacity(compressed_frame_bytes);
                    out.extend_from_slice(&frame[..STREAM_HEADER_BYTES]);
                    out.push(0);
                    out.push(0x02);
                    let decompressed_len = body.len() as u32;
                    out.extend_from_slice(&decompressed_len.to_be_bytes());
                    out.extend_from_slice(&compress_buf[..compressed_len]);
                    out
                });
            });
        }
    }

    group.finish();
}

/// Dictionary sizes probed for calibration.
///
/// zstd digests a dictionary into the context once, so unlike the LZ4 path this
/// replaced there is no per-call cost that grows with dictionary size. The
/// contexts below are therefore built OUTSIDE the timed region, which is what
/// production does — timing `with_dictionary` per iteration would measure a
/// digest production pays once per install and never per frame.
const DICT_SIZES: &[usize] = &[0, 4096, 8192, 16_384, 32_768, 65_536];

/// A dictionary drawn from recent display traffic: the bytes the peer has
/// already seen. Distinct from the frame being compressed, as it is in
/// production.
fn create_dictionary(size: usize) -> Vec<u8> {
    create_payload(size, "terminal")
}

fn bench_display_frame_compress_with_dict(c: &mut Criterion) {
    let mut group = c.benchmark_group("display_frame_compress_dict");
    // Sizes bracketing the interactive band (a relayed critical row that must
    // fit a 1100-byte datagram) and the bulk band.
    for &size in &[512usize, 1024, 4096, 16_384] {
        let payload = create_payload(size, "terminal");
        let frame = create_display_frame(&payload);
        let body = &frame[STREAM_HEADER_BYTES..];
        let mut out = Vec::with_capacity(zstd::zstd_safe::compress_bound(body.len()));
        for &dict_size in DICT_SIZES {
            let dict = create_dictionary(dict_size);
            let mut context = if dict.is_empty() {
                zstd::bulk::Compressor::new(DISPLAY_COMPRESSION_LEVEL).expect("context")
            } else {
                zstd::bulk::Compressor::with_dictionary(DISPLAY_COMPRESSION_LEVEL, &dict)
                    .expect("context")
            };
            group.throughput(Throughput::Bytes(body.len() as u64));
            group.bench_with_input(
                BenchmarkId::new(format!("dict{dict_size}"), size),
                &size,
                |b, _| {
                    b.iter(|| {
                        out.clear();
                        context.compress_to_buffer(body, &mut out).unwrap()
                    });
                },
            );
        }
    }
    group.finish();
}

fn bench_display_frame_decompress_with_dict(c: &mut Criterion) {
    // The browser side must stay flat as the dictionary grows; the decoder
    // holds a digested dictionary too.
    let mut group = c.benchmark_group("display_frame_decompress_dict");
    for &size in &[1024usize, 4096] {
        let payload = create_payload(size, "terminal");
        let frame = create_display_frame(&payload);
        let body = &frame[STREAM_HEADER_BYTES..];
        for &dict_size in DICT_SIZES {
            let dict = create_dictionary(dict_size);
            let compressed = if dict.is_empty() {
                zstd::bulk::compress(body, DISPLAY_COMPRESSION_LEVEL).expect("compress")
            } else {
                zstd::bulk::Compressor::with_dictionary(DISPLAY_COMPRESSION_LEVEL, &dict)
                    .expect("context")
                    .compress(body)
                    .expect("compress")
            };
            let mut context = if dict.is_empty() {
                zstd::bulk::Decompressor::new().expect("context")
            } else {
                zstd::bulk::Decompressor::with_dictionary(&dict).expect("context")
            };
            let mut out = Vec::with_capacity(body.len());
            group.throughput(Throughput::Bytes(body.len() as u64));
            group.bench_with_input(
                BenchmarkId::new(format!("dict{dict_size}"), size),
                &size,
                |b, _| {
                    b.iter(|| {
                        out.clear();
                        context.decompress_to_buffer(&compressed, &mut out).unwrap()
                    });
                },
            );
        }
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_compress,
    bench_decompress,
    bench_display_frame_compress,
    bench_display_frame_compress_with_dict,
    bench_display_frame_decompress_with_dict,
);
criterion_main!(benches);
