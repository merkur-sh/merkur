use merkur_codec::{DISPLAY_FEC_HEADER_BYTES, MSG_TYPE_DISPLAY_FEC_REPAIR};

/// Display parity encoder.
///
/// The encoder holds no group state and no scratch. Both parity producers —
/// the owner loop's inline send and the off-loop preparation worker — have the
/// complete group in hand before a repair is due, so they encode over the
/// exact frames that went on the wire, straight into the pooled repair frame:
/// `merkur_fec::encode` reads each borrowed datagram as if zero-padded to the
/// group's shard size, so nothing is staged or copied first.
pub struct FecEncoder;

impl FecEncoder {
    pub fn new() -> Self {
        Self
    }

    /// Encode one complete display group over borrowed payloads into `out`,
    /// the caller's buffer — a pooled frame on both display arms, so a steady
    /// group's parity allocates nothing. Returns whether a repair was written;
    /// `out` is cleared either way. `payloads` must hold at most
    /// `merkur_fec::FEC_MAX_DATA` entries, which the display group builders
    /// guarantee by capping every group at `DisplayPolicy::FEC_GROUP_MAX_SIZE`.
    pub fn encode_borrowed_group_into(
        &mut self,
        generation: u32,
        start_seq: u32,
        payloads: &[&[u8]],
        recovery_count: usize,
        out: &mut Vec<u8>,
    ) -> bool {
        encode_repair_parts(generation, start_seq, payloads, recovery_count, out)
    }

    /// Allocating form of [`encode_borrowed_group_into`] for the codec tests,
    /// which compare whole repair frames.
    #[cfg(test)]
    pub fn encode_borrowed_group(
        &mut self,
        generation: u32,
        start_seq: u32,
        payloads: &[&[u8]],
        recovery_count: usize,
    ) -> Option<Vec<u8>> {
        let mut repair = Vec::new();
        self.encode_borrowed_group_into(
            generation,
            start_seq,
            payloads,
            recovery_count,
            &mut repair,
        )
        .then_some(repair)
    }
}

fn encode_repair_parts(
    batch_generation: u32,
    batch_start_seq: u32,
    payloads: &[&[u8]],
    recovery_count: usize,
    out: &mut Vec<u8>,
) -> bool {
    out.clear();
    let Some(shard_size) = payloads.iter().map(|payload| payload.len()).max() else {
        return false;
    };
    if shard_size == 0 || shard_size > merkur_fec::FEC_MAX_SHARD_BYTES {
        return false;
    }
    if recovery_count == 0 || recovery_count > merkur_fec::FEC_MAX_RECOVERY {
        return false;
    }
    let data_count = payloads.len();
    if !(2..=merkur_fec::FEC_MAX_DATA).contains(&data_count) {
        return false;
    }

    let body_len = recovery_count * shard_size;
    out.reserve(DISPLAY_FEC_HEADER_BYTES + body_len);
    // Generation pins the repair to one seq space: seqs reset to 1 on every
    // generation bump, so without it a decoder can mix shards from different
    // generations and reconstruct garbage.
    out.extend_from_slice(&merkur_fec::repair::repair_header_bytes(
        MSG_TYPE_DISPLAY_FEC_REPAIR,
        &merkur_fec::repair::RepairHeader {
            batch_start_seq,
            data_shards: data_count as u8,
            recovery_shards: recovery_count as u8,
            shard_size: shard_size as u16,
            generation: batch_generation,
        },
        body_len as u16,
    ));
    // `encode` writes every body byte, straight from the borrowed datagrams.
    out.resize(DISPLAY_FEC_HEADER_BYTES + body_len, 0);
    let (first, second) = out[DISPLAY_FEC_HEADER_BYTES..].split_at_mut(shard_size);
    let mut recovery = [first, second];
    if merkur_fec::encode(payloads, &mut recovery[..recovery_count]).is_err() {
        out.clear();
        return false;
    }
    true
}

#[cfg(test)]
mod profile;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::display::policy::DisplayPolicy;

    fn parse_header(repair: &[u8]) -> (u32, usize, usize, usize) {
        let batch_start = u32::from_be_bytes(repair[4..8].try_into().unwrap());
        let data_count = repair[8] as usize;
        let recovery_count = repair[9] as usize;
        let shard_size = u16::from_be_bytes([repair[10], repair[11]]) as usize;
        (batch_start, data_count, recovery_count, shard_size)
    }

    fn parse_generation(repair: &[u8]) -> u32 {
        u32::from_be_bytes(repair[12..16].try_into().unwrap())
    }

    /// Decode a repair's recovery shards back out of the emitted frame.
    fn recovery_shards(repair: &[u8], recovery_count: usize, shard_size: usize) -> Vec<&[u8]> {
        let body = &repair[DISPLAY_FEC_HEADER_BYTES..];
        (0..recovery_count)
            .map(|j| &body[j * shard_size..(j + 1) * shard_size])
            .collect()
    }

    #[test]
    fn encoder_stages_nothing_between_groups() {
        // Parity goes straight from the borrowed datagrams into the pooled
        // frame, so the encoder has no scratch to pad into or copy out of.
        assert_eq!(std::mem::size_of::<FecEncoder>(), 0);
    }

    #[test]
    fn repair_carries_full_recovery_body() {
        let mut encoder = FecEncoder::new();
        let repair = encoder
            .encode_borrowed_group(
                7,
                10,
                &[&[0x20; 100][..], &[0x30; 80][..], &[0x40; 90][..]],
                DisplayPolicy::FEC_RECOVERY_SHARD_COUNT,
            )
            .expect("repair frame");

        assert_eq!(repair[0], MSG_TYPE_DISPLAY_FEC_REPAIR);
        let body_len = u16::from_be_bytes([repair[2], repair[3]]) as usize;
        let (batch_start, data_count, recovery_count, shard_size) = parse_header(&repair);

        assert_eq!(batch_start, 10);
        assert_eq!(parse_generation(&repair), 7);
        assert_eq!(data_count, 3);
        assert_eq!(recovery_count, DisplayPolicy::FEC_RECOVERY_SHARD_COUNT);
        // GF(2^8) imposes no even-byte constraint — exact max payload survives.
        assert_eq!(shard_size, 100);
        assert_eq!(body_len, recovery_count * shard_size);
        assert_eq!(repair.len(), DISPLAY_FEC_HEADER_BYTES + body_len);
    }

    #[test]
    fn repair_recovers_two_lost_shards() {
        let mut encoder = FecEncoder::new();
        let originals: [Vec<u8>; 3] = [vec![0x20; 60], vec![0x30; 40], vec![0x40; 50]];

        let repair = encoder
            .encode_borrowed_group(
                7,
                1,
                &[&originals[0][..], &originals[1][..], &originals[2][..]],
                DisplayPolicy::FEC_RECOVERY_SHARD_COUNT,
            )
            .expect("repair frame");

        let (_, data_count, recovery_count, shard_size) = parse_header(&repair);
        // Zero-pad originals to shard_size to match encoder behavior.
        let padded: Vec<Vec<u8>> = originals
            .iter()
            .map(|p| {
                let mut s = vec![0u8; shard_size];
                s[..p.len()].copy_from_slice(p);
                s
            })
            .collect();

        let recovery_shards = recovery_shards(&repair, recovery_count, shard_size);

        // Receive only shard 1; recover shards 0 and 2 using both recovery shards.
        let received_data_mask: u32 = 0b010;
        let received_recovery_mask: u32 = 0b11;
        let zero = vec![0u8; shard_size];
        let received_data: Vec<&[u8]> = vec![&zero, &padded[1], &zero];
        let mut output_storage: Vec<Vec<u8>> = vec![vec![0u8; shard_size]; data_count];
        let restored;
        {
            let mut output_refs: Vec<&mut [u8]> = output_storage
                .iter_mut()
                .map(|v| v.as_mut_slice())
                .collect();
            restored = merkur_fec::decode(
                received_data_mask,
                received_recovery_mask,
                &received_data,
                &recovery_shards,
                &mut output_refs,
            );
        }
        assert_eq!(restored, 0b101);
        assert_eq!(output_storage[0], padded[0]);
        assert_eq!(output_storage[2], padded[2]);
    }

    #[test]
    fn encoder_reuses_across_batches() {
        let mut encoder = FecEncoder::new();
        // First batch with shard_size=200.
        let r1 = encoder
            .encode_borrowed_group(
                7,
                100,
                &[&[1u8; 200][..], &[2u8; 150][..]],
                DisplayPolicy::FEC_RECOVERY_SHARD_COUNT,
            )
            .expect("repair 1");
        let (_, _, _, sz1) = parse_header(&r1);
        assert_eq!(sz1, 200);

        // Second batch with smaller shard_size=49 (odd — no longer requires even).
        let r2 = encoder
            .encode_borrowed_group(
                8,
                200,
                &[&[3u8; 40][..], &[4u8; 49][..]],
                DisplayPolicy::FEC_RECOVERY_SHARD_COUNT,
            )
            .expect("repair 2");
        let (_, _, _, sz2) = parse_header(&r2);
        assert_eq!(sz2, 49);
        assert_eq!(parse_generation(&r1), 7);
        assert_eq!(parse_generation(&r2), 8);
    }

    #[test]
    fn shrinking_group_does_not_inherit_the_pooled_frame_bytes() {
        // The pooled repair frame keeps its capacity, so a smaller group
        // encodes over memory still holding the previous group's parity, and
        // its shorter datagrams are read as zero-padded rather than copied.
        // Parity must depend only on the current group: encode the same small
        // group into a reused frame and into a fresh one and require identical
        // frames, then prove the reused frame still recovers its data shard.
        let mut encoder = FecEncoder::new();
        let mut pooled = Vec::new();
        assert!(encoder.encode_borrowed_group_into(
            7,
            1,
            &[&[0xEEu8; 900][..], &[0xDDu8; 900][..], &[0xCCu8; 900][..]],
            DisplayPolicy::FEC_RECOVERY_SHARD_COUNT,
            &mut pooled,
        ));

        let small: [&[u8]; 2] = [&[0x11u8; 40], &[0x22u8; 17]];
        assert!(encoder.encode_borrowed_group_into(
            8,
            5,
            &small,
            DisplayPolicy::FEC_RECOVERY_SHARD_COUNT,
            &mut pooled,
        ));
        let warm_repair = pooled;
        let cold_repair = FecEncoder::new()
            .encode_borrowed_group(8, 5, &small, DisplayPolicy::FEC_RECOVERY_SHARD_COUNT)
            .expect("cold repair");
        assert_eq!(warm_repair, cold_repair);

        let (_, data_count, recovery_count, shard_size) = parse_header(&warm_repair);
        assert_eq!(data_count, 2);
        assert_eq!(shard_size, 40);
        let padded: Vec<Vec<u8>> = small
            .iter()
            .map(|payload| {
                let mut shard = vec![0u8; shard_size];
                shard[..payload.len()].copy_from_slice(payload);
                shard
            })
            .collect();
        let recovery = recovery_shards(&warm_repair, recovery_count, shard_size);
        let zero = vec![0u8; shard_size];
        let received_data: Vec<&[u8]> = vec![&zero, &padded[1]];
        let mut output_storage: Vec<Vec<u8>> = vec![vec![0u8; shard_size]; data_count];
        let restored = {
            let mut output_refs: Vec<&mut [u8]> = output_storage
                .iter_mut()
                .map(|shard| shard.as_mut_slice())
                .collect();
            merkur_fec::decode(0b10, 0b11, &received_data, &recovery, &mut output_refs)
        };
        assert_eq!(restored, 0b1);
        assert_eq!(output_storage[0], padded[0]);
    }

    #[test]
    fn display_encoder_rejects_stale_k1_repair() {
        let mut encoder = FecEncoder::new();
        let payload = [0x20u8; 100];
        assert!(
            encoder
                .encode_borrowed_group(
                    9,
                    42,
                    &[&payload[..]],
                    DisplayPolicy::FEC_SINGLE_RECOVERY_SHARD_COUNT,
                )
                .is_none()
        );
    }
}
