use merkur_codec::{
    DISPLAY_CHUNK_COUNT_OFFSET, DISPLAY_CHUNK_INDEX_OFFSET, DISPLAY_DEMAND_SERIAL_OFFSET,
    DISPLAY_FRAME_ID_OFFSET, DISPLAY_PATCH_FLAGS_OFFSET, DISPLAY_PRESENTATION_ID_OFFSET,
    DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET, DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET,
    DISPLAY_ROW_COUNT_OFFSET, DISPLAY_STREAM_FLAGS_OFFSET, FRAME_HEADER_BODY_BYTES, FrameKind,
    MAX_DISPLAY_FRAME_BYTES, MSG_TYPE_DISPLAY_PATCH, PATCH_FLAG_DEMAND_AWAITS_GRANT,
    PATCH_FLAG_DEMAND_LIMITED, PATCH_FLAG_DEMAND_PROMPT, PATCH_FLAG_PRESENTATION_COHERENT,
    PATCH_FLAG_PRESENTATION_END,
    STREAM_HEADER_BYTES, StreamHeader, iter_rows_at, parse_frame_header_and_rows_start,
    write_stream_header,
};

// Resource bound on a batch of ordinary snapshot rows. A single larger row is
// indivisible and uses its exact size, bounded by MAX_DISPLAY_FRAME_BYTES.
// Keep the existing ordinary-row batch bound as the envelope becomes wider.
const SNAPSHOT_PACKING_BYTES: usize = STREAM_HEADER_BYTES + u16::MAX as usize;
const MAX_STREAM_FRAME_BYTES: usize = MAX_DISPLAY_FRAME_BYTES;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayFrameEncodeError {
    HeaderTooShort,
    BodyTooLarge,
    InvalidSnapshot,
    SnapshotRowTooLarge,
    TooManyChunks,
}

pub fn patch_stream_header(
    payload: &mut [u8],
    seq: u32,
    generation: u32,
    input_seq: u32,
    frame_id: u32,
    presentation_id: u32,
    presentation_coherent: bool,
    presentation_end: bool,
    chunk_index: u16,
    chunk_count: u16,
    presentation_member_index: u16,
    presentation_member_count: u16,
) -> Result<(), DisplayFrameEncodeError> {
    let body_length = payload
        .len()
        .checked_sub(STREAM_HEADER_BYTES)
        .ok_or(DisplayFrameEncodeError::HeaderTooShort)?;
    if payload.len() > MAX_STREAM_FRAME_BYTES {
        return Err(DisplayFrameEncodeError::BodyTooLarge);
    }
    let body_length = body_length as u32;

    // Preserve the flags byte rather than clearing it. It carries the
    // compression and FEC bits, so zeroing it here forces every producer to
    // stamp the header *before* compressing — which is precisely what stops a
    // batch from being compressed once, at the point where its size is being
    // decided, and re-stamped afterwards. A freshly encoded frame zeroes this
    // byte in `encode_frame_into`, so preserving it is never carrying garbage.
    let flags = payload[DISPLAY_STREAM_FLAGS_OFFSET];
    write_stream_header(
        payload,
        &StreamHeader {
            msg_type: MSG_TYPE_DISPLAY_PATCH,
            flags,
            body_len: body_length,
            seq,
            generation,
            input_seq,
        },
    );
    if payload.len() >= DISPLAY_FRAME_ID_OFFSET + 4 {
        payload[DISPLAY_FRAME_ID_OFFSET..DISPLAY_FRAME_ID_OFFSET + 4]
            .copy_from_slice(&frame_id.to_be_bytes());
    }
    if payload.len() >= DISPLAY_PRESENTATION_ID_OFFSET + 4 {
        payload[DISPLAY_PRESENTATION_ID_OFFSET..DISPLAY_PRESENTATION_ID_OFFSET + 4]
            .copy_from_slice(&presentation_id.to_be_bytes());
        let mut patch_flags = payload[DISPLAY_PATCH_FLAGS_OFFSET]
            & !(PATCH_FLAG_PRESENTATION_COHERENT | PATCH_FLAG_PRESENTATION_END);
        if presentation_coherent {
            patch_flags |= PATCH_FLAG_PRESENTATION_COHERENT;
        }
        if presentation_end {
            patch_flags |= PATCH_FLAG_PRESENTATION_END;
        }
        payload[DISPLAY_PATCH_FLAGS_OFFSET] = patch_flags;
    }
    // Datagram frames remain standalone (`chunk_count == 1`) with distinct
    // frame ids. Chunk indices survive for reliable snapshot assembly only;
    // browser presentation coalescing uses the independent advisory above.
    if payload.len() >= DISPLAY_CHUNK_COUNT_OFFSET + 2 {
        payload[DISPLAY_CHUNK_INDEX_OFFSET..DISPLAY_CHUNK_INDEX_OFFSET + 2]
            .copy_from_slice(&chunk_index.to_be_bytes());
        payload[DISPLAY_CHUNK_COUNT_OFFSET..DISPLAY_CHUNK_COUNT_OFFSET + 2]
            .copy_from_slice(&chunk_count.to_be_bytes());
    }
    if payload.len() >= DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET + 2 {
        payload[DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET
            ..DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET + 2]
            .copy_from_slice(&presentation_member_index.to_be_bytes());
        payload[DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET
            ..DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET + 2]
            .copy_from_slice(&presentation_member_count.to_be_bytes());
    }
    Ok(())
}

/// Turn a prepared transaction into an open presentation continuation.
///
/// This is used only when owner-loop state advances while the prepare worker
/// is running. It changes presentation advice, never frame application or ACK
/// semantics. Callers must discard precomputed FEC repair first because parity
/// covers these exact bytes.
pub fn mark_presentation_continues(payload: &mut [u8]) -> Result<(), DisplayFrameEncodeError> {
    if payload.len() < STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES {
        return Err(DisplayFrameEncodeError::HeaderTooShort);
    }
    payload[DISPLAY_PATCH_FLAGS_OFFSET] = (payload[DISPLAY_PATCH_FLAGS_OFFSET]
        | PATCH_FLAG_PRESENTATION_COHERENT)
        & !PATCH_FLAG_PRESENTATION_END;
    Ok(())
}

/// Stamp one peer's display demand into an encoded frame.
///
/// Written after encode and before FEC parity is computed over these bytes,
/// like the rest of the per-peer header patches.
pub fn stamp_display_demand(
    payload: &mut [u8],
    serial: u32,
    limited: bool,
    prompt: bool,
    awaits_grant: bool,
) -> Result<(), DisplayFrameEncodeError> {
    if payload.len() < STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES {
        return Err(DisplayFrameEncodeError::HeaderTooShort);
    }
    payload[DISPLAY_DEMAND_SERIAL_OFFSET..DISPLAY_DEMAND_SERIAL_OFFSET + 4]
        .copy_from_slice(&serial.to_be_bytes());
    let mut flags = payload[DISPLAY_PATCH_FLAGS_OFFSET]
        & !(PATCH_FLAG_DEMAND_LIMITED | PATCH_FLAG_DEMAND_PROMPT | PATCH_FLAG_DEMAND_AWAITS_GRANT);
    if limited {
        flags |= PATCH_FLAG_DEMAND_LIMITED;
    }
    if prompt {
        flags |= PATCH_FLAG_DEMAND_PROMPT;
    }
    if awaits_grant {
        flags |= PATCH_FLAG_DEMAND_AWAITS_GRANT;
    }
    payload[DISPLAY_PATCH_FLAGS_OFFSET] = flags;
    Ok(())
}

pub fn chunk_snapshot_frame(frame: &[u8]) -> Result<Vec<Vec<u8>>, DisplayFrameEncodeError> {
    let body_length = frame
        .len()
        .checked_sub(STREAM_HEADER_BYTES)
        .ok_or(DisplayFrameEncodeError::HeaderTooShort)?;
    let (header, rows_offset) = parse_frame_header_and_rows_start(frame)
        .map_err(|_| DisplayFrameEncodeError::InvalidSnapshot)?;
    if header.kind != FrameKind::Snapshot {
        return Err(DisplayFrameEncodeError::InvalidSnapshot);
    }
    if body_length <= SNAPSHOT_PACKING_BYTES - STREAM_HEADER_BYTES {
        return Ok(vec![frame.to_vec()]);
    }

    let mut chunks = Vec::new();
    let mut chunk = frame[..rows_offset].to_vec();
    let mut chunk_rows = 0u16;
    let mut consumed_end = rows_offset;
    for entry in iter_rows_at(frame, rows_offset, header.row_count) {
        let entry = entry.map_err(|_| DisplayFrameEncodeError::InvalidSnapshot)?;
        let row_end = entry
            .offset
            .checked_add(entry.len)
            .ok_or(DisplayFrameEncodeError::InvalidSnapshot)?;
        if entry.offset != consumed_end || row_end > frame.len() {
            return Err(DisplayFrameEncodeError::InvalidSnapshot);
        }
        if rows_offset + entry.len > MAX_STREAM_FRAME_BYTES {
            return Err(DisplayFrameEncodeError::SnapshotRowTooLarge);
        }
        if chunk_rows != 0 && chunk.len() + entry.len > SNAPSHOT_PACKING_BYTES {
            patch_chunk_row_count(&mut chunk, chunk_rows);
            chunks.push(chunk);
            chunk = frame[..rows_offset].to_vec();
            chunk_rows = 0;
        }
        chunk.extend_from_slice(&frame[entry.offset..row_end]);
        chunk_rows += 1;
        consumed_end = row_end;
    }
    if consumed_end != frame.len() || chunk_rows == 0 {
        return Err(DisplayFrameEncodeError::InvalidSnapshot);
    }
    patch_chunk_row_count(&mut chunk, chunk_rows);
    chunks.push(chunk);
    u16::try_from(chunks.len()).map_err(|_| DisplayFrameEncodeError::TooManyChunks)?;
    Ok(chunks)
}

fn patch_chunk_row_count(chunk: &mut [u8], row_count: u16) {
    debug_assert!(chunk.len() >= STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES);
    chunk[DISPLAY_ROW_COUNT_OFFSET..DISPLAY_ROW_COUNT_OFFSET + 2]
        .copy_from_slice(&row_count.to_be_bytes());
}

#[cfg(test)]
mod tests {

    /// The header reader and the header writer agree, field for field.
    ///
    /// They are the only two implementations of this layout in Rust, and they
    /// sit beside each other naming the same offset constants. This pins them
    /// together so a future edit to one cannot silently drift from the other.
    #[test]
    fn a_written_stream_header_reads_back_unchanged() {
        let mut payload = vec![0u8; STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES + 8];
        patch_stream_header(
            &mut payload,
            0xDEAD_BEEF,
            7,
            0x1234_5678,
            42,
            73,
            true,
            true,
            3,
            9,
            0,
            0,
        )
        .expect("header fits");

        let header = merkur_codec::parse_stream_header(&payload).expect("header reads back");
        assert_eq!(header.msg_type, MSG_TYPE_DISPLAY_PATCH);
        assert_eq!(header.seq, 0xDEAD_BEEF);
        assert_eq!(header.generation, 7);
        assert_eq!(header.input_seq, 0x1234_5678);
        assert_eq!(
            header.body_len as usize,
            payload.len() - STREAM_HEADER_BYTES
        );
    }

    /// A payload shorter than the header is rejected rather than read past.
    #[test]
    fn a_truncated_stream_header_is_refused() {
        for len in 0..STREAM_HEADER_BYTES {
            assert!(
                merkur_codec::parse_stream_header(&vec![0u8; len]).is_none(),
                "a {len}-byte payload was accepted as a stream header"
            );
        }
    }

    use super::*;

    #[test]
    fn patch_stream_header_writes_display_frame_id() {
        let mut payload = vec![0; STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES];
        payload[DISPLAY_PATCH_FLAGS_OFFSET] = merkur_codec::PATCH_FLAG_RESET;

        patch_stream_header(&mut payload, 7, 3, 2, 42, 73, true, true, 5, 9, 0, 0).unwrap();

        assert_eq!(u32::from_be_bytes(payload[6..10].try_into().unwrap()), 7);
        assert_eq!(u32::from_be_bytes(payload[10..14].try_into().unwrap()), 3);
        assert_eq!(u32::from_be_bytes(payload[14..18].try_into().unwrap()), 2);
        assert_eq!(
            u32::from_be_bytes(
                payload[DISPLAY_FRAME_ID_OFFSET..DISPLAY_FRAME_ID_OFFSET + 4]
                    .try_into()
                    .unwrap()
            ),
            42
        );
        assert_eq!(
            u32::from_be_bytes(
                payload[DISPLAY_PRESENTATION_ID_OFFSET..DISPLAY_PRESENTATION_ID_OFFSET + 4]
                    .try_into()
                    .unwrap()
            ),
            73
        );
        assert_eq!(
            payload[DISPLAY_PATCH_FLAGS_OFFSET],
            merkur_codec::PATCH_FLAG_RESET
                | PATCH_FLAG_PRESENTATION_COHERENT
                | PATCH_FLAG_PRESENTATION_END,
            "presentation restamping must preserve RESET"
        );
        assert_eq!(
            u16::from_be_bytes(
                payload[DISPLAY_CHUNK_INDEX_OFFSET..DISPLAY_CHUNK_INDEX_OFFSET + 2]
                    .try_into()
                    .unwrap()
            ),
            5
        );
        assert_eq!(
            u16::from_be_bytes(
                payload[DISPLAY_CHUNK_COUNT_OFFSET..DISPLAY_CHUNK_COUNT_OFFSET + 2]
                    .try_into()
                    .unwrap()
            ),
            9
        );
    }

    #[test]
    fn patch_stream_header_writes_message_type_byte() {
        let mut payload = vec![0u8; STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES];

        patch_stream_header(&mut payload, 0, 0, 0, 0, 0, false, false, 0, 1, 0, 0).unwrap();

        assert_eq!(payload[0], MSG_TYPE_DISPLAY_PATCH);
        assert_eq!(payload[1], 0);
    }

    /// Stamping a header must not clear the compression bit.
    ///
    /// The flags byte and the stream header share offset 1. Clearing it here
    /// would mean a frame can only be compressed *after* its sequence numbers
    /// are assigned, which is what prevented the batcher from compressing a
    /// batch at the moment it decides that batch's size.
    #[test]
    fn patch_stream_header_preserves_the_compression_flag() {
        let mut payload = vec![0u8; STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES];
        payload[merkur_codec::DISPLAY_HEADER_FLAGS_OFFSET] =
            merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD
                | merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT;

        patch_stream_header(&mut payload, 7, 3, 2, 42, 0, false, false, 1, 4, 0, 0).unwrap();

        assert_eq!(
            payload[merkur_codec::DISPLAY_HEADER_FLAGS_OFFSET],
            merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD
                | merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT
        );
        assert_eq!(payload[0], MSG_TYPE_DISPLAY_PATCH);
        assert_eq!(u32::from_be_bytes(payload[6..10].try_into().unwrap()), 7);
    }

    #[test]
    fn patch_stream_header_encodes_body_length_in_big_endian() {
        let mut payload = vec![0u8; STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES];

        patch_stream_header(&mut payload, 0, 0, 0, 0, 0, false, false, 0, 1, 0, 0).unwrap();

        let body_length = u32::from_be_bytes(payload[2..6].try_into().unwrap()) as usize;
        assert_eq!(body_length, payload.len() - STREAM_HEADER_BYTES);
    }

    #[test]
    fn patch_stream_header_is_noop_when_buffer_is_smaller_than_header() {
        let mut payload = vec![0xAB; STREAM_HEADER_BYTES - 1];
        let original = payload.clone();

        let result = patch_stream_header(&mut payload, 7, 3, 2, 42, 0, false, false, 0, 1, 0, 0);

        assert_eq!(result, Err(DisplayFrameEncodeError::HeaderTooShort));
        assert_eq!(payload, original);
    }

    #[test]
    fn patch_stream_header_skips_frame_id_when_buffer_too_short() {
        // Buffer is exactly long enough for the stream header, but not for the
        // optional display-frame-id slot. We must still write the header fields
        // and not panic on the missing frame-id range.
        let mut payload = vec![0u8; STREAM_HEADER_BYTES];

        patch_stream_header(&mut payload, 9, 5, 4, 11, 0, false, false, 0, 1, 0, 0).unwrap();

        assert_eq!(payload[0], MSG_TYPE_DISPLAY_PATCH);
        assert_eq!(u32::from_be_bytes(payload[6..10].try_into().unwrap()), 9);
        assert_eq!(u32::from_be_bytes(payload[10..14].try_into().unwrap()), 5);
    }

    #[test]
    fn patch_stream_header_writes_zero_seq_and_generation() {
        let mut payload = vec![0xFFu8; STREAM_HEADER_BYTES + 8];

        patch_stream_header(&mut payload, 0, 0, 0, 0, 0, false, false, 0, 1, 0, 0).unwrap();

        assert_eq!(u32::from_be_bytes(payload[6..10].try_into().unwrap()), 0);
        assert_eq!(u32::from_be_bytes(payload[10..14].try_into().unwrap()), 0);
    }

    #[test]
    fn patch_stream_header_accepts_maximum_body_length() {
        let mut payload = vec![0xFF; MAX_STREAM_FRAME_BYTES];

        patch_stream_header(&mut payload, 7, 3, 2, 42, 0, false, false, 0, 1, 0, 0).unwrap();

        assert_eq!(payload[0], MSG_TYPE_DISPLAY_PATCH);
        assert_eq!(
            u32::from_be_bytes(payload[2..6].try_into().unwrap()),
            (MAX_STREAM_FRAME_BYTES - STREAM_HEADER_BYTES) as u32
        );
        assert_eq!(u32::from_be_bytes(payload[6..10].try_into().unwrap()), 7);
        assert_eq!(u32::from_be_bytes(payload[10..14].try_into().unwrap()), 3);
    }

    #[test]
    fn patch_stream_header_rejects_resource_bound_without_mutation() {
        let mut payload = vec![0xAB; MAX_STREAM_FRAME_BYTES + 1];
        let original = payload.clone();

        let result = patch_stream_header(&mut payload, 7, 3, 2, 42, 0, false, false, 0, 1, 0, 0);

        assert_eq!(result, Err(DisplayFrameEncodeError::BodyTooLarge));
        assert_eq!(payload, original);
    }

    #[test]
    fn chunks_large_incompressible_snapshot_at_row_boundaries() {
        use merkur_codec::{
            CellRepr, FrameHeader, RowRef, STREAM_HEADER_BYTES as CODEC_HEADER, encode_frame_into,
        };

        const COLS: usize = 512;
        const ROWS: usize = 192;
        let mut random = 0x1234_5678u32;
        let rows: Vec<Vec<CellRepr>> = (0..ROWS)
            .map(|_| {
                (0..COLS)
                    .map(|_| {
                        random ^= random << 13;
                        random ^= random >> 17;
                        random ^= random << 5;
                        let first = random;
                        random ^= random << 13;
                        random ^= random >> 17;
                        random ^= random << 5;
                        CellRepr {
                            codepoint: 0x21 + first % 0x5e,
                            fg: first.to_be_bytes()[..3].try_into().unwrap(),
                            bg: random.to_be_bytes()[..3].try_into().unwrap(),
                            ..CellRepr::BLANK
                        }
                    })
                    .collect()
            })
            .collect();
        let header = FrameHeader {
            memory_only: false,
            kind: FrameKind::Snapshot,
            cols: COLS as u16,
            rows: ROWS as u16,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: 0,
            cursor_visible: 1,
            mode_flags: 0,
            row_count: ROWS as u16,
            frame_id: 0,
            presentation_id: 0,
            presentation_member_index: 0,
            presentation_member_count: 0,
            row_predecessor_presentation_id: 0,
            presentation_coherent: false,
            presentation_end: false,
            chunk_index: 0,
            chunk_count: 1,
            demand_serial: 0,
            demand_limited: false,
            demand_prompt: false,
            demand_awaits_grant: false,
            closure_digest: 0,
            scroll_serial: 0,
            echo_horizon: 0,
        };
        let mut snapshot = Vec::new();
        encode_frame_into(
            &mut snapshot,
            &header,
            rows.iter().enumerate().map(|(row_index, cells)| RowRef {
                graphics: &[],
                row_index: row_index as u16,
                left: 0,
                cells,
            }),
        );
        assert_eq!(CODEC_HEADER, STREAM_HEADER_BYTES);
        assert!(snapshot.len() > SNAPSHOT_PACKING_BYTES);
        assert!(
            zstd::bulk::compress(&snapshot[STREAM_HEADER_BYTES..], 3)
                .expect("compress")
                .len()
                > u16::MAX as usize
        );
        let (_, original_rows_offset) = parse_frame_header_and_rows_start(&snapshot).unwrap();

        let mut chunks = chunk_snapshot_frame(&snapshot).unwrap();
        let chunk_count = u16::try_from(chunks.len()).unwrap();
        assert!(chunk_count > 1);

        let mut assembled_rows = Vec::new();
        let mut assembled_row_count = 0usize;
        for (index, chunk) in chunks.iter_mut().enumerate() {
            patch_stream_header(
                chunk,
                0,
                7,
                73,
                42,
                0,
                false,
                false,
                index as u16,
                chunk_count,
                0,
                0,
            )
            .unwrap();
            assert!(chunk.len() <= MAX_STREAM_FRAME_BYTES);
            assert_eq!(
                u32::from_be_bytes(chunk[2..6].try_into().unwrap()) as usize,
                chunk.len() - STREAM_HEADER_BYTES
            );
            assert_eq!(u32::from_be_bytes(chunk[14..18].try_into().unwrap()), 73);
            let (chunk_header, chunk_rows_offset) =
                parse_frame_header_and_rows_start(chunk).unwrap();
            assert_eq!(chunk_header.kind, FrameKind::Snapshot);
            assert_eq!(chunk_header.frame_id, 42);
            assert_eq!(chunk_header.chunk_index, index as u16);
            assert_eq!(chunk_header.chunk_count, chunk_count);
            assembled_row_count += usize::from(chunk_header.row_count);
            assembled_rows.extend_from_slice(&chunk[chunk_rows_offset..]);
        }

        assert_eq!(assembled_row_count, ROWS);
        assert_eq!(assembled_rows, snapshot[original_rows_offset..]);
    }
}
