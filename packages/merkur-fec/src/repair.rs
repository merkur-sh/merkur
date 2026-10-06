//! Wire framing for a display FEC repair datagram.
//!
//! The daemon built this header and the browser parsed it, in two languages,
//! with no shared definition — the same split `merkur-e2e` exists to prevent
//! for crypto. The layout lives here now, beside the codec whose shards it
//! describes, so a repair can be produced and consumed by one implementation.
//!
//! Layout, all big-endian:
//!
//! ```text
//! 0      msg_type        u8
//! 1      flags           u8
//! 2..4   body_len        u16  recovery bytes following this header
//! 4..8   batch_start_seq u32  display seq of data shard 0
//! 8      data_shards     u8
//! 9      recovery_shards u8
//! 10..12 shard_size      u16  every shard is padded to this
//! 12..16 generation      u32  seqs reset per generation; without this a
//!                             decoder can mix generations and rebuild garbage
//! ```

use crate::codec::{FEC_MAX_DATA, FEC_MAX_RECOVERY, FEC_MAX_SHARD_BYTES, decode};

pub const REPAIR_HEADER_BYTES: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RepairHeader {
    pub batch_start_seq: u32,
    pub data_shards: u8,
    pub recovery_shards: u8,
    pub shard_size: u16,
    pub generation: u32,
}

/// The header bytes for a repair whose body is `body_len` bytes.
///
/// Returned by value rather than appended, so this crate keeps its no-allocation
/// property; the caller extends its own buffer.
pub fn repair_header_bytes(
    msg_type: u8,
    header: &RepairHeader,
    body_len: u16,
) -> [u8; REPAIR_HEADER_BYTES] {
    let mut out = [0u8; REPAIR_HEADER_BYTES];
    out[0] = msg_type;
    out[1] = 0;
    out[2..4].copy_from_slice(&body_len.to_be_bytes());
    out[4..8].copy_from_slice(&header.batch_start_seq.to_be_bytes());
    out[8] = header.data_shards;
    out[9] = header.recovery_shards;
    out[10..12].copy_from_slice(&header.shard_size.to_be_bytes());
    out[12..16].copy_from_slice(&header.generation.to_be_bytes());
    out
}

/// Split a repair datagram into its header and recovery body.
///
/// Returns `None` for anything malformed — truncated, zero shards, shard counts
/// past what the codec supports, or a body that does not hold exactly
/// `recovery_shards * shard_size` bytes.
pub fn parse_repair(payload: &[u8]) -> Option<(RepairHeader, &[u8])> {
    if payload.len() < REPAIR_HEADER_BYTES {
        return None;
    }
    let header = RepairHeader {
        batch_start_seq: u32::from_be_bytes(payload[4..8].try_into().ok()?),
        data_shards: payload[8],
        recovery_shards: payload[9],
        shard_size: u16::from_be_bytes(payload[10..12].try_into().ok()?),
        generation: u32::from_be_bytes(payload[12..16].try_into().ok()?),
    };
    let data_shards = usize::from(header.data_shards);
    let recovery_shards = usize::from(header.recovery_shards);
    let shard_size = usize::from(header.shard_size);
    if data_shards == 0
        || data_shards > FEC_MAX_DATA
        || recovery_shards == 0
        || recovery_shards > FEC_MAX_RECOVERY
        || shard_size == 0
        || shard_size > FEC_MAX_SHARD_BYTES
    {
        return None;
    }
    let body = &payload[REPAIR_HEADER_BYTES..];
    if body.len() != recovery_shards * shard_size {
        return None;
    }
    Some((header, body))
}

/// Rebuild the data shards a receiver is missing, without allocating.
///
/// `received[i]` is the payload whose display seq is `batch_start_seq + i`, or
/// `None` if it never arrived. Both scratch buffers must be at least
/// `data_shards * shard_size` bytes; the caller owns them so a receiver draining
/// a socket pays no per-batch allocation. On success, restored shard `i` occupies
/// `output[i * shard_size..(i + 1) * shard_size]`, zero-padded exactly as the
/// sender padded it — the caller trims using the frame's own length field.
///
/// Returns the bitmask of restored shard indices, or 0 if recovery was
/// impossible or the inputs were inconsistent.
///
/// Deliberately stateless. Which seqs belong to a batch, and how long to retain
/// them, is receiver policy that differs between a browser with a live socket
/// and a harness replaying a transcript. The format and the math are what must
/// not be written twice.
pub fn recover_batch_into(
    header: &RepairHeader,
    received: &[Option<&[u8]>],
    recovery_body: &[u8],
    padded: &mut [u8],
    output: &mut [u8],
) -> u32 {
    let data_shards = usize::from(header.data_shards);
    let recovery_shards = usize::from(header.recovery_shards);
    let shard_size = usize::from(header.shard_size);
    let span = data_shards * shard_size;
    if received.len() != data_shards
        || recovery_body.len() != recovery_shards * shard_size
        || padded.len() < span
        || output.len() < span
    {
        return 0;
    }

    // Pad every received shard to shard_size the way the sender did before
    // computing parity. Parity over a short shard rebuilds garbage, and a
    // retained scratch still holds the previous batch's bytes in the padding
    // region, so the fill is unconditional.
    let mut received_mask = 0u32;
    for (index, shard) in received.iter().enumerate() {
        let slot = &mut padded[index * shard_size..(index + 1) * shard_size];
        match shard {
            Some(bytes) => {
                // The sender pads every shard up to `shard_size` and never
                // protects a longer one, so a longer shard was not part of
                // this batch: parity over a cut copy of it rebuilds garbage.
                let Some((head, padding)) = slot.split_at_mut_checked(bytes.len()) else {
                    return 0;
                };
                head.copy_from_slice(bytes);
                padding.fill(0);
                received_mask |= 1 << index;
            }
            None => slot.fill(0),
        }
    }

    let recovery_mask = if recovery_shards >= 32 {
        u32::MAX
    } else {
        (1u32 << recovery_shards) - 1
    };

    let mut data_refs: [&[u8]; FEC_MAX_DATA] = [&[]; FEC_MAX_DATA];
    for (index, slot) in padded[..span].chunks_exact(shard_size).enumerate() {
        data_refs[index] = slot;
    }
    let mut recovery_refs: [&[u8]; FEC_MAX_RECOVERY] = [&[]; FEC_MAX_RECOVERY];
    for (index, slot) in recovery_body.chunks_exact(shard_size).enumerate() {
        recovery_refs[index] = slot;
    }

    let mut output_refs: [&mut [u8]; FEC_MAX_DATA] = Default::default();
    let mut rest = &mut output[..span];
    let mut taken = 0usize;
    while taken < data_shards {
        let (head, tail) = rest.split_at_mut(shard_size);
        output_refs[taken] = head;
        rest = tail;
        taken += 1;
    }

    decode(
        received_mask,
        recovery_mask,
        &data_refs[..data_shards],
        &recovery_refs[..recovery_shards],
        &mut output_refs[..data_shards],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::encode;
    use alloc::vec;
    use alloc::vec::Vec;

    fn build(data: &[Vec<u8>], recovery_shards: usize) -> (RepairHeader, Vec<u8>) {
        let shard_size = data.iter().map(|shard| shard.len()).max().expect("shards");
        let padded: Vec<Vec<u8>> = data
            .iter()
            .map(|shard| {
                let mut buffer = vec![0u8; shard_size];
                buffer[..shard.len()].copy_from_slice(shard);
                buffer
            })
            .collect();
        let refs: Vec<&[u8]> = padded.iter().map(|shard| shard.as_slice()).collect();
        let mut recovery = vec![0u8; recovery_shards * shard_size];
        {
            let mut chunks: Vec<&mut [u8]> = recovery.chunks_mut(shard_size).collect();
            encode(&refs, &mut chunks).expect("encode");
        }
        (
            RepairHeader {
                batch_start_seq: 100,
                data_shards: data.len() as u8,
                recovery_shards: recovery_shards as u8,
                shard_size: shard_size as u16,
                generation: 3,
            },
            recovery,
        )
    }

    /// A repair header survives the round trip its two languages used to make
    /// separately.
    #[test]
    fn a_written_repair_header_reads_back_unchanged() {
        let header = RepairHeader {
            batch_start_seq: 0xABCD_1234,
            data_shards: 3,
            recovery_shards: 2,
            shard_size: 512,
            generation: 9,
        };
        let mut out = repair_header_bytes(0x21, &header, 2 * 512).to_vec();
        out.resize(REPAIR_HEADER_BYTES + 2 * 512, 0);
        let (parsed, body) = parse_repair(&out).expect("parses");
        assert_eq!(parsed, header);
        assert_eq!(body.len(), 2 * 512);
    }

    /// Malformed repairs are refused rather than half-read.
    #[test]
    fn a_malformed_repair_is_refused() {
        let header = RepairHeader {
            batch_start_seq: 1,
            data_shards: 2,
            recovery_shards: 1,
            shard_size: 8,
            generation: 1,
        };
        let mut good = repair_header_bytes(0x21, &header, 8).to_vec();
        good.resize(REPAIR_HEADER_BYTES + 8, 0);
        assert!(parse_repair(&good).is_some());

        // Truncated header.
        for len in 0..REPAIR_HEADER_BYTES {
            assert!(parse_repair(&good[..len]).is_none(), "accepted {len} bytes");
        }
        // Body length disagrees with the header.
        assert!(
            parse_repair(&good[..REPAIR_HEADER_BYTES + 4]).is_none(),
            "accepted a body that does not match recovery_shards * shard_size"
        );
        // Zero shards.
        let mut zero = repair_header_bytes(
            0x21,
            &RepairHeader {
                data_shards: 0,
                ..header
            },
            8,
        )
        .to_vec();
        zero.resize(REPAIR_HEADER_BYTES + 8, 0);
        assert!(parse_repair(&zero).is_none(), "accepted zero data shards");
    }

    /// A received shard longer than the batch's shard size is not a shard of
    /// the batch. Cutting it to size and counting it would rebuild from bytes
    /// the parity never covered.
    #[test]
    fn a_shard_longer_than_the_batch_shard_size_recovers_nothing() {
        let data = [vec![1u8; 8], vec![2u8; 8], vec![3u8; 8]];
        let (header, recovery) = build(&data, 1);
        let span = data.len() * usize::from(header.shard_size);
        let (mut padded, mut output) = (vec![0u8; span], vec![0u8; span]);

        // The true shard with one byte more: cut to size it is exactly the
        // shard the parity covers, so a truncating receiver would "recover".
        let mut over_long = data[1].clone();
        over_long.push(9);
        let received = [None, Some(over_long.as_slice()), Some(data[2].as_slice())];
        assert_eq!(
            recover_batch_into(&header, &received, &recovery, &mut padded, &mut output),
            0
        );

        // The same batch with the shard at its size rebuilds the missing one.
        let received = [None, Some(data[1].as_slice()), Some(data[2].as_slice())];
        assert_eq!(
            recover_batch_into(&header, &received, &recovery, &mut padded, &mut output),
            1
        );
        assert_eq!(&output[..8], data[0].as_slice());
    }

    /// One lost shard is rebuilt exactly.
    #[test]
    fn a_single_lost_shard_is_rebuilt() {
        let data = vec![
            b"the quick brown fox".to_vec(),
            b"jumps over the lazy".to_vec(),
            b"dog and keeps going".to_vec(),
        ];
        let (header, recovery) = build(&data, 2);
        let shard_size = usize::from(header.shard_size);

        for missing in 0..data.len() {
            let received: Vec<Option<&[u8]>> = data
                .iter()
                .enumerate()
                .map(|(index, shard)| {
                    if index == missing {
                        None
                    } else {
                        Some(shard.as_slice())
                    }
                })
                .collect();
            let mut padded = vec![0u8; data.len() * shard_size];
            let mut output = vec![0u8; data.len() * shard_size];
            let restored =
                recover_batch_into(&header, &received, &recovery, &mut padded, &mut output);
            assert!(
                restored & (1 << missing) != 0,
                "shard {missing} was not recoverable"
            );
            let rebuilt = &output[missing * shard_size..(missing + 1) * shard_size];
            let mut expected = vec![0u8; shard_size];
            expected[..data[missing].len()].copy_from_slice(&data[missing]);
            assert_eq!(
                rebuilt,
                &expected[..],
                "shard {missing} rebuilt incorrectly"
            );
        }
    }

    /// More losses than parity cannot be recovered, and says so.
    #[test]
    fn losing_more_than_the_parity_is_unrecoverable() {
        let data = vec![b"aaaa".to_vec(), b"bbbb".to_vec(), b"cccc".to_vec()];
        let (header, recovery) = build(&data, 1);
        let received: Vec<Option<&[u8]>> = vec![Some(data[0].as_slice()), None, None];
        let shard_size = usize::from(header.shard_size);
        let mut padded = vec![0u8; 3 * shard_size];
        let mut output = vec![0u8; 3 * shard_size];
        assert_eq!(
            recover_batch_into(&header, &received, &recovery, &mut padded, &mut output),
            0,
            "two losses were reported recoverable from one parity shard"
        );
    }

    /// Reused scratch must not leak the previous batch into a rebuilt shard.
    ///
    /// The scratch buffers are caller-owned and grown to a high-water mark, so
    /// by design they still hold the last batch's bytes in the padding region.
    /// Parity computed over stale padding rebuilds garbage. Handing this call
    /// pre-dirtied scratch is the only way to catch a missing fill — freshly
    /// zeroed buffers hide it completely.
    #[test]
    fn reused_scratch_does_not_leak_a_previous_batch() {
        let data = vec![b"alpha".to_vec(), b"be".to_vec(), b"gamma!!".to_vec()];
        let (header, recovery) = build(&data, 2);
        let shard_size = usize::from(header.shard_size);
        let span = data.len() * shard_size;

        // Dirty scratch, as a reused buffer would be.
        let mut padded = vec![0xABu8; span];
        let mut output = vec![0xCDu8; span];

        let received: Vec<Option<&[u8]>> =
            vec![Some(data[0].as_slice()), None, Some(data[2].as_slice())];
        let restored = recover_batch_into(&header, &received, &recovery, &mut padded, &mut output);
        assert!(restored & 0b010 != 0, "the lost shard was not recovered");

        let rebuilt = &output[shard_size..2 * shard_size];
        let mut expected = vec![0u8; shard_size];
        expected[..data[1].len()].copy_from_slice(&data[1]);
        assert_eq!(
            rebuilt,
            &expected[..],
            "a shard rebuilt from dirty scratch does not match the original"
        );
    }
}
