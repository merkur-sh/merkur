//! Bounded proofs of the display frame header, which the browser and the
//! native viewer parse from untrusted datagrams.
use merkur_codec::*;

mod bounded {
    include!("bounded.rs");
}
use bounded::bounded;

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Every field read stays inside the length the parser checked, and each
/// in-place patch offset names the bytes the parser reads for that field.
#[test]
#[cfg_attr(kani, kani::proof)]
#[cfg_attr(kani, kani::unwind(76))]
fn proof_frame_header() {
    const HEADER_BYTES: usize = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
    let header_bytes = HEADER_BYTES;
    bounded::<{ HEADER_BYTES + 1 }>(|bytes: &[u8]| {
        let Ok((header, rows_start)) = parse_frame_header_and_rows_start(bytes) else {
            return;
        };
        #[cfg(kani)]
        kani::cover!(
            bytes.len() > header_bytes,
            "a header followed by rows parses"
        );
        assert_eq!(rows_start, header_bytes);
        assert_eq!(bytes[DISPLAY_VERSION_OFFSET], VERSION);
        assert_eq!(header.frame_id, u32_at(bytes, DISPLAY_FRAME_ID_OFFSET));
        assert_eq!(
            header.presentation_id,
            u32_at(bytes, DISPLAY_PRESENTATION_ID_OFFSET)
        );
        assert_eq!(
            header.chunk_index,
            u16_at(bytes, DISPLAY_CHUNK_INDEX_OFFSET)
        );
        assert_eq!(
            header.chunk_count,
            u16_at(bytes, DISPLAY_CHUNK_COUNT_OFFSET)
        );
        assert_eq!(header.row_count, u16_at(bytes, DISPLAY_ROW_COUNT_OFFSET));
        assert_eq!(
            header.presentation_member_index,
            u16_at(bytes, DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET)
        );
        assert_eq!(
            header.presentation_member_count,
            u16_at(bytes, DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET)
        );
        assert_eq!(
            header.row_predecessor_presentation_id,
            u32_at(bytes, DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET)
        );
        assert_eq!(
            header.demand_serial,
            u32_at(bytes, DISPLAY_DEMAND_SERIAL_OFFSET)
        );
        assert_eq!(
            header.closure_digest,
            (u64::from(u32_at(bytes, DISPLAY_CLOSURE_DIGEST_OFFSET)) << 32)
                | u64::from(u32_at(bytes, DISPLAY_CLOSURE_DIGEST_OFFSET + 4))
        );
        assert_eq!(
            header.scroll_serial,
            u32_at(bytes, DISPLAY_SCROLL_SERIAL_OFFSET)
        );
        assert_eq!(
            header.echo_horizon,
            u32_at(bytes, DISPLAY_ECHO_HORIZON_OFFSET)
        );
        let flags = bytes[DISPLAY_PATCH_FLAGS_OFFSET];
        assert_eq!(
            header.presentation_end,
            flags & PATCH_FLAG_PRESENTATION_END != 0
        );
        assert_eq!(header.memory_only, flags & PATCH_FLAG_MEMORY_ONLY != 0);
        assert!(parse_frame_header_and_rows_start(&bytes[..header_bytes - 1]).is_err());
    });
}
