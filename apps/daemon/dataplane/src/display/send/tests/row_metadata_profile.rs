//! Full native display-pipeline instruction and output oracle. Network delivery
//! and receiver rendering are outside this profile.

use super::*;
use crate::edge_tunnel::test_allocations;
use std::hash::Hasher;
use std::hint::black_box;

fn instructions() -> u64 {
    let mut counters = [0u64; 2];
    // SAFETY: SYS_thread_selfcounts flavor 1 writes two u64 counters into
    // this initialized 16-byte buffer on the current thread.
    let result = unsafe { libc::syscall(186, 1, counters.as_mut_ptr(), 16usize) };
    assert_eq!(result, 0);
    counters[0]
}

fn screen(shape: &str, seed: u8) -> Vec<u8> {
    if matches!(shape, "character" | "log" | "history") {
        return terminal_fixture(120, 40, seed);
    }
    let mut out = Vec::new();
    for row in 0..40u16 {
        out.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
        if shape == "links" {
            out.extend_from_slice(b"\x1b]8;id=profile;https://example.com\x1b\\");
        }
        for col in 0..120u16 {
            if shape == "rgb" {
                out.extend_from_slice(format!("\x1b[38;2;17;{};{}m", col, row).as_bytes());
            }
            if shape == "unicode" {
                let ch =
                    char::from_u32(0x410 + u32::from((col + row + u16::from(seed)) % 32)).unwrap();
                let mut bytes = [0; 4];
                out.extend_from_slice(ch.encode_utf8(&mut bytes).as_bytes());
            } else {
                let [row, _] = row.to_le_bytes();
                let [col, _] = col.to_le_bytes();
                out.push(b' ' + (seed.wrapping_add(row).wrapping_add(col) % 95));
            }
        }
        if shape == "links" {
            out.extend_from_slice(b"\x1b]8;;\x1b\\");
        }
    }
    out
}

fn graphics() -> (PreparedGraphics, Option<merkur_graphics::budget::Lease>) {
    use merkur_graphics::budget::{Budget, Usage};
    use merkur_graphics::geometry::{CELL_UNIT, RowSlice};
    use merkur_graphics::projection::{Fragment, Stack};
    use merkur_graphics::source::SourceManifest;

    let pixels =
        merkur_graphics::processing::Pixels::new(1, 1, vec![20, 40, 60, 255].into_boxed_slice())
            .unwrap();
    let fragment = Fragment {
        content: SourceManifest::from_pixels(&pixels).content(),
        stack: Stack {
            z: -1,
            image_id: 1,
            placement: 1,
        },
        slice: RowSlice {
            left: CELL_UNIT,
            right: 2 * CELL_UNIT,
            top: 0,
            bottom: CELL_UNIT,
            source_left: 0,
            source_right: CELL_UNIT,
            source_top: 0,
            source_bottom: CELL_UNIT,
        },
    };
    PreparedGraphics::new(
        &Budget::new(Usage {
            bytes: 4096,
            objects: 4,
        }),
        120,
        &[fragment],
        &mut Default::default(),
    )
    .unwrap()
}

#[test]
#[ignore = "release hardware profile; --ignored --nocapture --test-threads=1"]
#[expect(
    clippy::too_many_lines,
    reason = "one fixture keeps the measured owner turn and its immediate ACK baseline together"
)]
fn full_pipeline() {
    const ROUNDS: usize = 2000;
    for shape in [
        "character",
        "log",
        "redraw",
        "rgb",
        "unicode",
        "links",
        "graphics",
        "history",
    ] {
        let (tx, _rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(120, 40, tx);
        let fixtures = [screen(shape, b'a'), screen(shape, b'b')];
        terminal.apply_bytes(&fixtures[0]);
        let (image, _charge) = graphics();
        if shape == "graphics" {
            terminal.publish_graphics_projection(vec![image]);
        }
        let (mut peer, mut browser) = benchmark_noise_pair();
        peer.display_cache.resize(120, 40);
        peer.display_cache
            .references
            .shared()
            .push(crate::display::mz_peer::MzFact::Generation {
                generation: peer.generation,
                previous_floor: None,
            });
        let mut hashes = Vec::new();
        let mut dirty = Vec::new();
        terminal.update_hashes_for_dirty_rows(&mut hashes, &mut dirty);
        for row in &dirty {
            peer.display_cache.acked_row_cells[usize::from(row.row)] = row.cells.clone();
        }
        terminal.clear_dirty();
        let mut capture_scratch = RowCaptureScratch::default();
        let mut cache = HashMap::new();
        let mut captures = Vec::new();
        let mut requests = Vec::new();
        let mut compressor = Compressor::new();
        let mut fec = crate::display::fec::FecEncoder::new();
        let mut frames = frame_pool_for_test();
        let mut scratch = PrepareScratch::default();
        scratch.pin_sender_service(20.0);
        let mut datagrams = Vec::new();
        let mut opened = vec![0; 65_536];
        let mut fingerprint = std::collections::hash_map::DefaultHasher::new();
        let mut retired = 0u64;
        let mut nanos = 0u128;
        let mut allocations = 0usize;
        let mut allocated_bytes = 0usize;
        let mut packets = 0usize;
        let mut wire_bytes = 0usize;
        let mut copied = 0usize;
        let warmups = if matches!(shape, "log" | "history") {
            12_000
        } else {
            128
        };
        let lines = [
            b"2026-10-31 INFO request completed status=200 bytes=4096 duration=12ms a\r\n",
            b"2026-10-31 INFO request completed status=200 bytes=4096 duration=12ms b\r\n",
        ];
        for round in 0..warmups + ROUNDS {
            captures.clear();
            cache.clear();
            dirty.clear();
            recycle_frames_for_test(&mut datagrams, &mut frames);
            if shape == "character" {
                terminal.apply_bytes(b"\x1b[20;40H");
            } else if matches!(shape, "log" | "history") {
                terminal.apply_bytes(b"\x1b[40;1H");
            }
            let bytes = match shape {
                "character" => {
                    if round % 2 == 0 {
                        b"a".as_slice()
                    } else {
                        b"b".as_slice()
                    }
                }
                "log" | "history" => lines[round % 2].as_slice(),
                _ => &fixtures[round % 2],
            };
            let started = Instant::now();
            let before = instructions();
            test_allocations::begin_thread();
            terminal.apply_bytes(bytes);
            terminal.update_hashes_for_dirty_rows(&mut hashes, &mut dirty);
            for row in &dirty {
                cache.insert(row.row, row.clone());
            }
            requests.clear();
            requests.extend(
                dirty
                    .iter()
                    .map(|row| DisplayRowRequest::literal(row.row, shape == "history")),
            );
            capture_prepare_rows(
                &terminal,
                &peer,
                &requests,
                terminal.current_cursor_row(),
                &mut capture_scratch,
                &mut cache,
                &mut captures,
            );
            build_captured_datagram_batches(
                terminal.display_header_state(),
                &mut terminal,
                &mut peer,
                &captures,
                0,
                true,
                false,
                false,
                1,
                10_000.0,
                &mut compressor,
                &mut scratch,
                &mut frames,
                &mut datagrams,
            );
            precompute_fec_repairs(
                &mut datagrams,
                DisplayPolicy::FEC_GROUP_MAX_SIZE,
                peer.generation,
                &mut fec,
                &mut frames,
            );
            for datagram in &mut datagrams {
                let plaintext = datagram.frame.wire_frame();
                let wire = peer.seal_display_wire(plaintext).unwrap();
                let len = browser
                    .open_into(
                        crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap(),
                        true,
                        &wire[1..],
                        &mut opened,
                    )
                    .unwrap();
                assert_eq!(&opened[..len], plaintext);
                black_box(wire);
            }
            let tally = test_allocations::end_thread();
            let count = instructions() - before;
            let elapsed = started.elapsed().as_nanos();
            if round >= warmups {
                retired += count;
                nanos += elapsed;
                allocations += tally.allocations;
                allocated_bytes += tally.allocated_bytes;
                for datagram in &mut datagrams {
                    let wire = datagram.frame.wire_frame();
                    fingerprint.write(wire);
                    packets += 1;
                    wire_bytes += wire.len();
                    copied += usize::from(datagram.history_copies);
                }
            }
            // Delivery and exact immediate ACK provenance sit outside capture.
            // History arms admit only complete rows the produced frames carried.
            if shape == "history" {
                let shared = peer.display_cache.references.shared();
                for datagram in &datagrams {
                    shared.push(crate::display::mz_peer::MzFact::Applied {
                        seq: datagram.seq,
                        rows: datagram
                            .rows
                            .iter()
                            .filter(|row| row.complete)
                            .map(|row| (row.row, row.cells.clone()))
                            .collect(),
                        coded: datagram.mz_coded,
                        declared: datagram.mz_declared,
                    });
                }
            }
            for row in &dirty {
                peer.display_cache.acked_row_cells[usize::from(row.row)] = row.cells.clone();
            }
            terminal.clear_dirty();
        }
        println!(
            "ROW_PIPELINE shape={shape} instructions={} ns={} allocations={} allocated_bytes={} packets={} wire_bytes={} history_copies={copied} attempts={} fingerprint={:016x}",
            retired as f64 / ROUNDS as f64,
            nanos as f64 / ROUNDS as f64,
            allocations as f64 / ROUNDS as f64,
            allocated_bytes as f64 / ROUNDS as f64,
            packets as f64 / ROUNDS as f64,
            wire_bytes as f64 / ROUNDS as f64,
            compressor.display_frame_compression_attempts(),
            fingerprint.finish(),
        );
    }
}

#[test]
#[ignore = "release pre-encoded snapshot control; --ignored --nocapture --test-threads=1"]
fn preencoded_snapshots() {
    for shape in [
        "blank",
        "redraw",
        "rgb",
        "unicode",
        "links",
        "graphics",
        "tiny",
        "tiny-rgb",
        "tiny-unicode",
        "tiny-links",
        "tiny-rle",
    ] {
        let tiny = shape.starts_with("tiny");
        let rounds = if tiny { 65_536 } else { 1024 };
        let (tx, _rx) = crossbeam_channel::unbounded();
        let mut terminal = if tiny {
            TerminalState::new(2, 1, tx)
        } else {
            TerminalState::new(120, 40, tx)
        };
        if tiny {
            terminal.apply_bytes(match shape {
                "tiny-rgb" => b"\x1b[38;2;17;39;53mab",
                "tiny-unicode" => "аб".as_bytes(),
                "tiny-links" => b"\x1b]8;id=profile;https://example.com\x1b\\ab\x1b]8;;\x1b\\",
                "tiny-rle" => b"  ",
                _ => b"ab",
            });
        } else if shape != "blank" {
            terminal.apply_bytes(&screen(shape, b'a'));
        }
        let (image, _charge) = graphics();
        if shape == "graphics" {
            terminal.publish_graphics_projection(vec![image]);
        }
        let mut raw = Vec::new();
        let mut coded = Vec::new();
        let mut compressor = Compressor::new();
        for _ in 0..64 {
            raw = terminal.encode_snapshot_into(raw).0;
            raw[0] = merkur_codec::MSG_TYPE_DISPLAY_PATCH;
            black_box(compressor.compress_display_frame_into(&raw, &mut coded));
        }
        let mut fingerprint = std::collections::hash_map::DefaultHasher::new();
        fingerprint.write(&raw);
        fingerprint.write(&coded);
        let before = instructions();
        test_allocations::begin_thread();
        for _ in 0..rounds {
            raw = terminal.encode_snapshot_into(raw).0;
            raw[0] = merkur_codec::MSG_TYPE_DISPLAY_PATCH;
            black_box(compressor.compress_display_frame_into(&raw, &mut coded));
        }
        let tally = test_allocations::end_thread();
        let retired = instructions() - before;
        println!(
            "ROW_SNAPSHOT shape={shape} instructions={} allocations={} allocated_bytes={} raw={} coded={} fingerprint={:016x}",
            retired as f64 / f64::from(rounds),
            tally.allocations,
            tally.allocated_bytes,
            raw.len(),
            coded.len(),
            fingerprint.finish(),
        );
    }
}

#[test]
#[ignore = "release forced rejected-attempt control; --ignored --nocapture --test-threads=1"]
#[expect(
    clippy::too_many_lines,
    reason = "the measured turn includes VT, capture, encoding, rejection and authenticated delivery"
)]
fn rejected_attempts() {
    const ROUNDS: u32 = 4096;
    for rgb in [false, true] {
        let (tx, _rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(120, 40, tx);
        terminal.apply_bytes(&terminal_fixture(120, 40, b'Q'));
        let (mut peer, mut browser) = benchmark_noise_pair();
        peer.display_cache.resize(120, 40);
        let mut hashes = Vec::new();
        let mut dirty = Vec::new();
        terminal.update_hashes_for_dirty_rows(&mut hashes, &mut dirty);
        for row in &dirty {
            peer.display_cache.acked_row_cells[usize::from(row.row)] = row.cells.clone();
        }
        terminal.clear_dirty();
        let mut capture_scratch = RowCaptureScratch::default();
        let mut cache = HashMap::new();
        let mut captures = Vec::new();
        let mut requests = Vec::new();
        let mut compressor = Compressor::new();
        let mut frames = frame_pool_for_test();
        let mut scratch = PrepareScratch::default();
        scratch.pin_sender_service(20.0);
        let mut batches: Vec<PackedBatch> = Vec::new();
        let mut opened = vec![0; 65_536];
        let mut fingerprint = std::collections::hash_map::DefaultHasher::new();
        let mut retired = 0u64;
        let mut allocations = 0usize;
        let mut allocated_bytes = 0usize;
        for round in 0..ROUNDS + 128 {
            for (payload, _, _, _) in batches.drain(..) {
                frames.put(payload.frame);
            }
            cache.clear();
            captures.clear();
            dirty.clear();
            terminal.apply_bytes(b"\x1b[20;40H");
            if rgb {
                terminal.apply_bytes(b"\x1b[38;2;17;39;53m");
            }
            let before = instructions();
            test_allocations::begin_thread();
            terminal.apply_bytes(if round % 2 == 0 { b"a" } else { b"b" });
            terminal.update_hashes_for_dirty_rows(&mut hashes, &mut dirty);
            for row in &dirty {
                cache.insert(row.row, row.clone());
            }
            requests.clear();
            requests.extend(
                dirty
                    .iter()
                    .map(|row| DisplayRowRequest::literal(row.row, false)),
            );
            capture_prepare_rows(
                &terminal,
                &peer,
                &requests,
                terminal.current_cursor_row(),
                &mut capture_scratch,
                &mut cache,
                &mut captures,
            );
            let policy =
                display_compression_policy(&peer, 10_000.0, true, ExecutionLane::Inline, 0);
            let header = terminal.current_display_header(merkur_codec::FrameKind::Delta);
            let reserve = packed_header_reserve(&header, 1, captures.len());
            emit_fitted_batches(
                header,
                &captures,
                DisplayUtility::Critical,
                &policy,
                &policy.planning_profiles,
                DisplayWorkload::Stream,
                &mut compressor,
                &mut scratch.planner,
                &mut frames,
                &mut batches,
                DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES,
                reserve,
                Representation::Compressed,
                None,
            );
            assert_eq!(batches.len(), 1);
            let (payload, _, _, _) = &batches[0];
            assert_eq!(payload.compression, BatchCompression::AttemptedRejected);
            let wire = peer.seal_display_wire(&payload.frame).unwrap();
            let len = browser
                .open_into(
                    crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap(),
                    true,
                    &wire[1..],
                    &mut opened,
                )
                .unwrap();
            assert_eq!(&opened[..len], payload.frame);
            let tally = test_allocations::end_thread();
            let count = instructions() - before;
            if round >= 128 {
                retired += count;
                allocations += tally.allocations;
                allocated_bytes += tally.allocated_bytes;
                fingerprint.write(&payload.frame);
            }
            for row in &dirty {
                peer.display_cache.acked_row_cells[usize::from(row.row)] = row.cells.clone();
            }
            terminal.clear_dirty();
        }
        println!(
            "ROW_REJECTED rgb={rgb} instructions={} allocations={allocations} allocated_bytes={allocated_bytes} attempts={} fingerprint={:016x}",
            retired as f64 / f64::from(ROUNDS),
            compressor.display_frame_compression_attempts(),
            fingerprint.finish(),
        );
    }
}
