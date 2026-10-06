//! The browser decoder's rules, over batches the daemon's encoder would send:
//! protected patches and a repair of `merkur-fec` parity over them.

use merkur_codec::{StreamHeader, write_stream_header};
use merkur_fec::encode;
use merkur_fec::repair::repair_header_bytes;

use super::*;

/// A protected patch of `generation`/`seq` whose body is `len` bytes of `fill`.
fn protected(generation: u32, seq: u32, len: usize, fill: u8) -> Vec<u8> {
    let mut frame = vec![fill; STREAM_HEADER_BYTES + len];
    write_stream_header(
        &mut frame,
        &StreamHeader {
            msg_type: MSG_TYPE_DISPLAY_PATCH,
            flags: DISPLAY_HEADER_FLAG_FEC_PROTECTED,
            body_len: len as u32,
            seq,
            generation,
            input_seq: 0,
        },
    );
    frame
}

/// The repair envelope over `frames` with `recovery_shards` parity shards.
fn repair(generation: u32, frames: &[Vec<u8>], recovery_shards: u8) -> Vec<u8> {
    let shard_size = frames.iter().map(Vec::len).max().expect("frames");
    let padded: Vec<Vec<u8>> = frames
        .iter()
        .map(|frame| {
            let mut shard = frame.clone();
            shard.resize(shard_size, 0);
            shard
        })
        .collect();
    let data: Vec<&[u8]> = padded.iter().map(Vec::as_slice).collect();
    let mut body = vec![0u8; usize::from(recovery_shards) * shard_size];
    {
        let mut parity: Vec<&mut [u8]> = body.chunks_mut(shard_size).collect();
        encode(&data, &mut parity).expect("parity");
    }
    let start = parse_stream_header(&frames[0]).expect("a frame").seq;
    let header = RepairHeader {
        batch_start_seq: start,
        data_shards: frames.len() as u8,
        recovery_shards,
        shard_size: shard_size as u16,
        generation,
    };
    let mut envelope =
        repair_header_bytes(MSG_TYPE_DISPLAY_FEC_REPAIR, &header, body.len() as u16).to_vec();
    envelope.extend_from_slice(&body);
    envelope
}

fn batch(generation: u32, start: u32) -> Vec<Vec<u8>> {
    (0..4)
        .map(|offset| {
            protected(
                generation,
                start + offset,
                40 + offset as usize * 7,
                offset as u8 + 1,
            )
        })
        .collect()
}

fn feed(decoder: &mut FecDecoder, payload: &[u8]) -> Vec<Vec<u8>> {
    let mut rebuilt = Rebuilt::default();
    decoder.receive(payload, &mut rebuilt);
    rebuilt.iter().map(<[u8]>::to_vec).collect()
}

#[test]
fn a_lost_frame_is_rebuilt_exactly_when_its_repair_arrives() {
    let mut decoder = FecDecoder::default();
    let frames = batch(3, 10);
    for (offset, frame) in frames.iter().enumerate() {
        if offset != 2 {
            assert!(feed(&mut decoder, frame).is_empty());
        }
    }
    assert_eq!(
        feed(&mut decoder, &repair(3, &frames, 1)),
        [frames[2].clone()]
    );
    assert!(decoder.batches.is_empty(), "a recovered batch is complete");
}

#[test]
fn a_repair_that_overtakes_its_frames_waits_for_enough_of_them() {
    let mut decoder = FecDecoder::default();
    let frames = batch(3, 10);
    assert!(feed(&mut decoder, &repair(3, &frames, 1)).is_empty());
    assert!(feed(&mut decoder, &frames[0]).is_empty());
    assert!(feed(&mut decoder, &frames[1]).is_empty());
    assert_eq!(feed(&mut decoder, &frames[3]), [frames[2].clone()]);
}

#[test]
fn a_batch_that_lost_nothing_completes_without_rebuilding() {
    let mut decoder = FecDecoder::default();
    let frames = batch(3, 10);
    for frame in &frames {
        feed(&mut decoder, frame);
    }
    assert!(feed(&mut decoder, &repair(3, &frames, 2)).is_empty());
    assert!(decoder.batches.is_empty());
    assert!(decoder.retained.iter().all(|slot| slot.seq == 0));
}

#[test]
fn a_finished_batch_lends_its_recovery_buffer_to_the_next_repair() {
    let mut decoder = FecDecoder::default();
    let first = batch(3, 10);
    for frame in &first {
        feed(&mut decoder, frame);
    }
    feed(&mut decoder, &repair(3, &first, 2));
    assert_eq!(decoder.spare.len(), 1);
    let (buffer, capacity) = (decoder.spare[0].as_ptr(), decoder.spare[0].capacity());

    // The next batch loses a frame, so its repair is held until it is used.
    let second = batch(3, 14);
    for frame in &second[1..] {
        feed(&mut decoder, frame);
    }
    assert_eq!(
        feed(&mut decoder, &repair(3, &second, 2)),
        [second[0].clone()]
    );
    assert_eq!(decoder.spare.len(), 1, "one buffer serves both batches");
    assert_eq!(decoder.spare[0].as_ptr(), buffer);
    assert_eq!(decoder.spare[0].capacity(), capacity);
    assert!(decoder.spare[0].is_empty());
}

#[test]
fn rebuilt_frames_reuse_their_storage_from_one_arrival_to_the_next() {
    let mut decoder = FecDecoder::default();
    let mut rebuilt = Rebuilt::default();
    let first = batch(3, 10);
    for frame in &first[1..] {
        decoder.receive(frame, &mut rebuilt);
    }
    decoder.receive(&repair(3, &first, 1), &mut rebuilt);
    assert!(rebuilt.iter().eq([first[0].as_slice()]));
    let storage = rebuilt.frames[0].as_ptr();

    // An arrival that rebuilds nothing leaves none of the last one's frames.
    let second = batch(3, 14);
    decoder.receive(&second[1], &mut rebuilt);
    assert_eq!(rebuilt.iter().count(), 0);
    for frame in &second[2..] {
        decoder.receive(frame, &mut rebuilt);
    }
    decoder.receive(&repair(3, &second, 1), &mut rebuilt);
    assert!(rebuilt.iter().eq([second[0].as_slice()]));
    assert_eq!(rebuilt.frames.len(), 1);
    assert_eq!(rebuilt.frames[0].as_ptr(), storage);
}

#[test]
fn more_losses_than_parity_rebuild_nothing() {
    let mut decoder = FecDecoder::default();
    let frames = batch(3, 10);
    feed(&mut decoder, &frames[0]);
    feed(&mut decoder, &frames[3]);
    assert!(feed(&mut decoder, &repair(3, &frames, 1)).is_empty());
    assert_eq!(decoder.batches.len(), 1, "it waits for another frame");
}

#[test]
fn a_rebuilt_frame_that_names_another_place_is_dropped() {
    let mut decoder = FecDecoder::default();
    let frames = batch(3, 10);
    let mut corrupt = repair(3, &frames, 1);
    let last = corrupt.len() - 1;
    corrupt[REPAIR_BODY_OFFSET + 6] ^= 0xff;
    corrupt[last] ^= 0xff;
    for frame in &frames[1..] {
        feed(&mut decoder, frame);
    }
    assert!(feed(&mut decoder, &corrupt).is_empty());
}

/// Where a repair's parity starts: after its 16-byte header.
const REPAIR_BODY_OFFSET: usize = merkur_fec::repair::REPAIR_HEADER_BYTES;

#[test]
fn an_older_generation_is_ignored_and_a_newer_one_clears_the_slate() {
    let mut decoder = FecDecoder::default();
    let current = batch(5, 10);
    for frame in &current[1..] {
        feed(&mut decoder, frame);
    }
    // Same sequences, previous generation: disjoint parity groups.
    let old = batch(4, 10);
    assert!(feed(&mut decoder, &repair(4, &old, 1)).is_empty());
    assert_eq!(
        feed(&mut decoder, &repair(5, &current, 1)),
        [current[0].clone()]
    );

    let newer = batch(6, 10);
    feed(&mut decoder, &newer[1]);
    assert_eq!(decoder.generation, 6);
    assert!(
        feed(&mut decoder, &repair(6, &newer, 1)).is_empty(),
        "nothing of generation 5 survives to fill generation 6's batch"
    );
}

#[test]
fn single_shard_and_flagged_repairs_are_refused() {
    let mut decoder = FecDecoder::default();
    let frames = batch(3, 10);
    let single = repair(3, &frames[..1], 1);
    assert!(feed(&mut decoder, &single).is_empty());
    assert!(decoder.batches.is_empty());
    let mut flagged = repair(3, &frames, 1);
    flagged[1] = 1;
    assert!(feed(&mut decoder, &flagged).is_empty());
    assert!(decoder.batches.is_empty());
}

#[test]
fn a_frame_past_the_retention_window_cannot_fill_a_batch() {
    let mut decoder = FecDecoder::default();
    let frames = batch(3, 10);
    for frame in &frames[1..] {
        feed(&mut decoder, frame);
    }
    feed(
        &mut decoder,
        &protected(3, 13 + RETENTION_WINDOW + 1, 40, 9),
    );
    assert!(feed(&mut decoder, &repair(3, &frames, 1)).is_empty());
    assert!(decoder.batches.is_empty(), "an expired batch is not kept");
}

#[test]
fn sequences_wrap_past_zero() {
    assert_eq!(add(0xffff_ffff, 1), 1);
    assert_eq!(add(0xffff_fffe, 3), 2);
    assert_eq!(forward_distance(0xffff_ffff, 1), 1);
    let mut decoder = FecDecoder::default();
    let frames: Vec<Vec<u8>> = [0xffff_fffe, 0xffff_ffff, 1, 2]
        .iter()
        .map(|&seq| protected(3, seq, 50, seq as u8))
        .collect();
    for frame in [&frames[0], &frames[1], &frames[3]] {
        feed(&mut decoder, frame);
    }
    assert_eq!(
        feed(&mut decoder, &repair(3, &frames, 1)),
        [frames[2].clone()]
    );
}

/// A frame longer than a shard is in no batch, so it is not kept: the
/// retention is bounded by its slots times one shard, not times the largest
/// frame a peer can send.
#[test]
fn a_protected_frame_longer_than_a_shard_is_not_retained() {
    let mut decoder = FecDecoder::default();
    for len in [FEC_MAX_SHARD_BYTES + 1, 2 * 1024 * 1024] {
        let frame = protected(3, 10, len - STREAM_HEADER_BYTES, 7);
        assert_eq!(frame.len(), len);
        assert!(feed(&mut decoder, &frame).is_empty());
        let slot = &decoder.retained[slot_of(10)];
        assert_eq!(slot.seq, 0, "a {len}-byte frame took a slot");
        assert_eq!(slot.bytes.capacity(), 0, "a {len}-byte frame grew a slot");
    }
    assert_eq!(
        decoder.newest, None,
        "and it is not a frame of any generation"
    );

    // The largest shard is kept, and its slot holds exactly that.
    let frame = protected(3, 10, FEC_MAX_SHARD_BYTES - STREAM_HEADER_BYTES, 7);
    assert!(feed(&mut decoder, &frame).is_empty());
    let slot = &decoder.retained[slot_of(10)];
    assert_eq!((slot.seq, slot.bytes.len()), (10, FEC_MAX_SHARD_BYTES));
}

/// A rebuilt shard whose header claims a body past the shard was rebuilt
/// from a wrong input. The claim is checked against the bytes after the
/// header: the sum of the two lengths wraps a 32-bit `usize`.
#[test]
fn a_rebuilt_frame_claiming_a_body_past_its_shard_is_dropped() {
    let header_bytes = STREAM_HEADER_BYTES as u32;
    // On a 32-bit target each wraps `header + body` to a length inside the
    // shard, the last to exactly zero.
    for body_len in [
        u32::MAX,
        u32::MAX - header_bytes + 9,
        u32::MAX - header_bytes + 1,
    ] {
        let mut frames = batch(3, 10);
        write_stream_header(
            &mut frames[2],
            &StreamHeader {
                msg_type: MSG_TYPE_DISPLAY_PATCH,
                flags: DISPLAY_HEADER_FLAG_FEC_PROTECTED,
                body_len,
                seq: 12,
                generation: 3,
                input_seq: 0,
            },
        );
        assert_eq!(plausible(&frames[2], 12, 3), None, "body of {body_len}");

        let mut decoder = FecDecoder::default();
        for (offset, frame) in frames.iter().enumerate() {
            if offset != 2 {
                assert!(feed(&mut decoder, frame).is_empty());
            }
        }
        assert!(
            feed(&mut decoder, &repair(3, &frames, 1)).is_empty(),
            "a rebuilt frame claiming a body of {body_len} was handed on"
        );
    }
    // The claim that fits is the frame.
    let frames = batch(3, 10);
    assert_eq!(plausible(&frames[2], 12, 3), Some(frames[2].len()));
}
