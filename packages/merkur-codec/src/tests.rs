use crate::{
    CellAttrs, CellRepr, CodecErr, DisplayFrameValidationError, EncodeError, FrameHeader,
    FrameKind, RowRef, cell_iter, decode_varint_u32, encode_cells, encode_frame_into,
    encode_varint_u32, encoded_cells_size, iter_rows, link_spans, parse_frame_header,
    try_encode_frame_into, validate_display_frame,
};
use proptest::prelude::*;

#[test]
fn snapshot_graphics_allowance_reserves_worst_case_text_and_links() {
    for (columns, rows) in [(1u16, 256u16), (512, 192), (384, 256), (80, 24)] {
        let cells: Vec<_> = (0..columns)
            .map(|column| CellRepr {
                codepoint: 0x10000 + u32::from(column),
                fg: [1, 2, 3],
                bg: [4, 5, 6],
                attrs: CellAttrs::NONE,
                link: u32::from(column) + 1,
            })
            .collect();
        let mut encoded = Vec::new();
        encode_cells(&mut encoded, &cells);
        let text = usize::from(rows)
            * (crate::STREAM_HEADER_BYTES
                + crate::FRAME_HEADER_BODY_BYTES
                + crate::ROW_PREFIX_BYTES
                + encoded.len());
        assert!(
            text + crate::snapshot_graphics_budget(columns, rows).unwrap()
                <= crate::MAX_DISPLAY_SNAPSHOT_BYTES
        );
    }
    assert_eq!(crate::snapshot_graphics_budget(0, 1), None);
    assert_eq!(crate::snapshot_graphics_budget(512, 256), None);
}

/// Owned mirror of a decoded row entry, so a round-trip test can rebuild the
/// exact entry list it decoded without borrowing from the encoded buffer.
struct DecodedRow {
    row_index: u16,
    cells: Vec<CellRepr>,
}

fn cell_strategy() -> impl Strategy<Value = CellRepr> {
    (
        32u32..=0x7eu32,
        any::<[u8; 3]>(),
        any::<[u8; 3]>(),
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
        // Mostly unlinked, with a few ids so adjacent spans of different links
        // and links split across style runs both occur.
        prop_oneof![6 => Just(0u32), 1 => Just(1u32), 1 => Just(2u32), 1 => Just(u32::MAX)],
    )
        .prop_map(
            |(codepoint, fg, bg, wide, bold, italic, underline, inverse, link)| CellRepr {
                codepoint,
                fg,
                bg,
                attrs: CellAttrs::NONE
                    .with(CellAttrs::WIDE, wide)
                    .with(CellAttrs::BOLD, bold)
                    .with(CellAttrs::ITALIC, italic)
                    .with(CellAttrs::UNDERLINE, underline)
                    .with(CellAttrs::INVERSE, inverse),
                link,
            },
        )
}

proptest! {
    #[test]
    fn encode_decode_reencode_is_byte_equal(
        cols in 1u16..=300,
        rows in 2u16..=80,
        row_count in 1usize..=8,
        cells in prop::collection::vec(cell_strategy(), 1..=300),
        presentation_id in any::<u32>(),
        presentation_member_index in any::<u16>(),
        presentation_member_count in any::<u16>(),
        row_predecessor_presentation_id in any::<u32>(),
        presentation_coherent in any::<bool>(),
        presentation_end in any::<bool>(),
        demand_serial in any::<u32>(),
        demand_limited in any::<bool>(),
        demand_prompt in any::<bool>(),
        demand_awaits_grant in any::<bool>(),
        closure_digest in any::<u64>(),
        scroll_serial in any::<u32>(),
        echo_horizon in any::<u32>(),
    ) {
        let row_count = row_count.min(usize::from(rows));
        let header = FrameHeader {
            memory_only: false,
            kind: FrameKind::Delta,
            cols,
            rows,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: 1,
            cursor_visible: 1,
            mode_flags: 0,
            row_count: row_count as u16,
            frame_id: 0,
            presentation_id,
            presentation_member_index,
            presentation_member_count,
            row_predecessor_presentation_id,
            presentation_coherent,
            presentation_end,
            chunk_index: 0,
            chunk_count: 1,
            demand_serial,
            demand_limited,
            demand_prompt,
            demand_awaits_grant,
            closure_digest,
            scroll_serial,
            echo_horizon,
        };
        let entries: Vec<RowRef<'_>> = (0..row_count)
            .map(|idx| RowRef {
                graphics: &[],
                row_index: idx as u16,
                left: 0,
                cells: cells.as_slice(),
            })
            .collect();
        let mut encoded = Vec::new();
        encode_frame_into(&mut encoded, &header, entries.into_iter());

        prop_assert_eq!(parse_frame_header(&encoded).unwrap(), header);
        prop_assert_eq!(
            &encoded[crate::DISPLAY_DEMAND_SERIAL_OFFSET..crate::DISPLAY_DEMAND_SERIAL_OFFSET + 4],
            &demand_serial.to_be_bytes()
        );
        prop_assert_eq!(
            &encoded[crate::DISPLAY_CLOSURE_DIGEST_OFFSET..crate::DISPLAY_CLOSURE_DIGEST_OFFSET + 8],
            &closure_digest.to_be_bytes()
        );
        prop_assert_eq!(
            &encoded[crate::DISPLAY_SCROLL_SERIAL_OFFSET..crate::DISPLAY_SCROLL_SERIAL_OFFSET + 4],
            &scroll_serial.to_be_bytes()
        );
        prop_assert_eq!(
            &encoded[crate::DISPLAY_ECHO_HORIZON_OFFSET..crate::DISPLAY_ECHO_HORIZON_OFFSET + 4],
            &echo_horizon.to_be_bytes()
        );
        let decoded: Vec<DecodedRow> = iter_rows(&encoded)
            .map(|row| {
                let row = row.unwrap();
                let mut cells = cell_iter(row.cells).map(|cell| cell.unwrap()).collect::<Vec<_>>();
                for span in link_spans(row.links, cells.len()) {
                    let span = span.unwrap();
                    let start = usize::from(span.offset);
                    for cell in &mut cells[start..start + usize::from(span.len)] {
                        cell.link = span.link;
                    }
                }
                assert_eq!(row.left, 0);
                assert_eq!(row.right, cells.len().saturating_sub(1) as u16);
                DecodedRow { row_index: row.row_index, cells }
            })
            .collect();
        prop_assert_eq!(decoded.len(), row_count);

        let decoded_refs = decoded.iter().map(|row| RowRef {
            graphics: &[],
            row_index: row.row_index,
            left: 0,
            cells: row.cells.as_slice(),
        });
        let mut reencoded = Vec::new();
        encode_frame_into(&mut reencoded, &header, decoded_refs);
        prop_assert_eq!(encoded, reencoded);
    }

    /// The scheduler sizes datagram batches with `encoded_cells_size`, so it
    /// must price the link table exactly as `encode_cells` writes it.
    #[test]
    fn encoded_size_matches_encoded_bytes_with_links(
        cells in prop::collection::vec(cell_strategy(), 1..=512),
    ) {
        let mut encoded = Vec::new();
        encode_cells(&mut encoded, &cells);
        prop_assert_eq!(encoded_cells_size(&cells), encoded.len());
    }

    /// The validator lowers link spans back onto exactly the cells that carried
    /// them, in both the in-memory and streaming forms.
    #[test]
    fn validated_rows_carry_their_links(
        cells in prop::collection::vec(cell_strategy(), 1..=120),
        left in 0u16..8,
    ) {
        let cols = cells.len() as u16 + left;
        let header = link_test_header(cols, 1);
        let mut encoded = Vec::new();
        encode_frame_into(
            &mut encoded,
            &header,
            std::iter::once(RowRef { graphics: &[], row_index: 0, left, cells: &cells }),
        );
        let mut rows = Vec::new();
        let mut decoded = Vec::new();
        let mut seen = Vec::new();
        validate_display_frame(&encoded, &mut rows, &mut decoded, &mut seen, &mut Vec::new(), &mut Vec::new()).unwrap();
        prop_assert_eq!(rows[0].left, left);
        prop_assert_eq!(&decoded, &cells);

        // The compressed receiver hands over only the row region.
        let body = &encoded[crate::STREAM_HEADER_BYTES + crate::FRAME_HEADER_BODY_BYTES..];
        let mut region_cells = Vec::new();
        crate::validate_display_rows(
            header,
            body,
            &mut rows,
            &mut region_cells,
            &mut seen,
            &mut Vec::new(),
            &mut Vec::new(),
        )
        .unwrap();
        prop_assert_eq!(&region_cells, &cells);
    }

    #[test]
    fn arbitrary_wire_bytes_are_panic_free_and_iterators_are_bounded(
        bytes in prop::collection::vec(any::<u8>(), 0..=2048),
        rows_offset in any::<usize>(),
        row_count in any::<u16>(),
    ) {
        let _ = parse_frame_header(&bytes);

        let mut rows = crate::iter_rows_at(&bytes, rows_offset, row_count);
        let mut row_results = 0usize;
        while let Some(row) = rows.next() {
            row_results += 1;
            if row.is_err() {
                prop_assert_eq!(rows.next(), None);
                break;
            }
        }
        prop_assert!(row_results <= usize::from(row_count));

        let mut cells = cell_iter(&bytes);
        for _ in 0..=u16::MAX {
            match cells.next() {
                Some(Ok(_)) => {}
                Some(Err(_)) => {
                    prop_assert_eq!(cells.next(), None);
                    break;
                }
                None => break,
            }
        }
        prop_assert_eq!(cells.next(), None);
    }
}

/// The tag's default-color omission is the codec's single largest lever: it is
/// what makes an ordinary cell cost two bytes instead of eight.
///
/// It only pays off while the encoder's idea of "default" matches the color the
/// terminal actually produces for an unstyled cell. Those are two independent
/// definitions, and when they drifted apart every cell of every frame silently
/// carried six redundant RGB bytes — the omission never fired once. Assert both
/// the agreement and the resulting wire size, so neither can regress quietly.
#[test]
fn an_unstyled_cell_omits_its_colors_on_the_wire() {
    use alacritty_terminal::vte::ansi::{Color, NamedColor};

    assert_eq!(
        crate::resolve_color(Color::Named(NamedColor::Foreground)),
        crate::encode::DEFAULT_FG,
        "an unstyled cell's foreground must be what the encoder treats as default",
    );
    assert_eq!(
        crate::resolve_color(Color::Named(NamedColor::Background)),
        crate::encode::DEFAULT_BG,
        "an unstyled cell's background must be what the encoder treats as default",
    );

    let mut encoded = Vec::new();
    crate::encode_cells(
        &mut encoded,
        &[CellRepr {
            codepoint: u32::from('x'),
            ..CellRepr::BLANK
        }],
    );
    assert_eq!(
        encoded.len(),
        3,
        "row color mode, then a tag byte plus a one-byte varint codepoint",
    );
}

/// `indexed_color_for` is the encoder's inverse of the palette table, and the
/// wire is only lossless while every index it returns maps back to the exact
/// color it was asked about. Duplicated palette slots make this a non-bijection,
/// so assert the round trip rather than equality of indices.
#[test]
fn every_palette_slot_survives_the_index_round_trip() {
    for index in 0..=255u8 {
        let color = crate::INDEXED_COLOR_TABLE[usize::from(index)];
        let recovered = crate::indexed_color_for(color)
            .unwrap_or_else(|| panic!("palette color {color:?} at {index} is not invertible"));
        assert_eq!(
            crate::INDEXED_COLOR_TABLE[usize::from(recovered)],
            color,
            "index {recovered} must reproduce the color it was derived from",
        );
    }
}

/// A color outside the palette must not be mistaken for one, or the decoder
/// would resolve it to a different color than the terminal produced.
#[test]
fn a_non_palette_color_is_not_claimed_by_the_index_inverse() {
    for color in [
        [1, 2, 3],
        [240, 240, 240],
        [94, 95, 96],
        [7, 7, 7],
        [239, 239, 239],
    ] {
        assert_eq!(
            crate::indexed_color_for(color),
            None,
            "{color:?} is not a palette color",
        );
    }
}

/// The two properties the per-row color mode exists to guarantee: a palette
/// color costs one byte, and — the reason the mode is per row rather than per
/// cell — a 24-bit color still costs exactly the three bytes it always did.
/// A per-cell discriminant would have made every true color cost four.
#[test]
fn palette_colors_cost_one_byte_and_true_colors_stay_at_three() {
    const CELLS: usize = 40;
    let palette_row: Vec<CellRepr> = (0..CELLS)
        .map(|index| CellRepr {
            codepoint: u32::from('a') + (index as u32 % 26),
            fg: crate::INDEXED_COLOR_TABLE[17 + index],
            ..CellRepr::BLANK
        })
        .collect();
    let true_color_row: Vec<CellRepr> = (0..CELLS)
        .map(|index| CellRepr {
            codepoint: u32::from('a') + (index as u32 % 26),
            fg: [1, 2, index as u8],
            ..CellRepr::BLANK
        })
        .collect();

    // Each cell is a tag plus a one-byte codepoint, so anything beyond two
    // bytes per cell is color, and the row pays one mode byte in total.
    // Each cell is a tag plus a one-byte codepoint; the row pays one mode byte.
    let per_cell = 2 * CELLS + 1;
    let mut encoded = Vec::new();
    crate::encode_cells(&mut encoded, &palette_row);
    assert_eq!(encoded.len(), per_cell + CELLS, "one index byte per cell");

    encoded.clear();
    crate::encode_cells(&mut encoded, &true_color_row);
    assert_eq!(
        encoded.len(),
        per_cell + 3 * CELLS,
        "a true color must not pay an escape byte on a true-color row",
    );

    // A row that is mostly palette keeps its indices and pays one escape,
    // rather than demoting every color to a literal.
    let mut mixed = palette_row.clone();
    mixed[7].fg = [1, 2, 3];
    encoded.clear();
    crate::encode_cells(&mut encoded, &mixed);
    assert_eq!(
        encoded.len(),
        per_cell + (CELLS - 1) + 4,
        "one escaped literal"
    );

    for row in [&palette_row, &true_color_row, &mixed] {
        let mut bytes = Vec::new();
        crate::encode_cells(&mut bytes, row);
        assert_eq!(
            bytes.len(),
            crate::encoded_cells_size(row),
            "size must match"
        );
        let decoded: Vec<CellRepr> = cell_iter(&bytes).map(|c| c.unwrap()).collect();
        assert_eq!(decoded.as_slice(), row.as_slice());
    }
}

/// The color mode occupies a byte at the *same* offset in every row payload,
/// and that placement is load-bearing rather than incidental.
///
/// An earlier revision wrote the byte lazily, immediately before a row's first
/// color, so that an unstyled row paid nothing. It measured worse: rows are
/// highly similar to one another, and a byte inserted at a position that varies
/// per row shifts their payloads out of alignment and shortens the cross-row
/// matches LZ4 depends on. Emitting it unconditionally costs one byte per row
/// and recovers far more than that from the compressor.
#[test]
fn the_color_mode_byte_sits_at_a_fixed_offset_in_every_row() {
    let unstyled: Vec<CellRepr> = (0..20)
        .map(|index| CellRepr {
            codepoint: u32::from('a') + (index % 26),
            ..CellRepr::BLANK
        })
        .collect();
    let styled: Vec<CellRepr> = unstyled
        .iter()
        .enumerate()
        .map(|(index, cell)| CellRepr {
            fg: crate::INDEXED_COLOR_TABLE[17 + index],
            ..*cell
        })
        .collect();

    for row in [&unstyled, &styled] {
        let mut encoded = Vec::new();
        crate::encode_cells(&mut encoded, row);
        assert_eq!(
            encoded.first().copied(),
            Some(crate::encode::COLOR_MODE_INDEXED),
            "the mode is always the first byte of a row payload",
        );
        assert_eq!(encoded.len(), crate::encoded_cells_size(row));
        let decoded: Vec<CellRepr> = cell_iter(&encoded).map(|cell| cell.unwrap()).collect();
        assert_eq!(decoded.as_slice(), row.as_slice());
    }

    // An unstyled row is the mode byte plus two bytes per cell, and nothing else.
    let mut encoded = Vec::new();
    crate::encode_cells(&mut encoded, &unstyled);
    assert_eq!(encoded.len(), 1 + 2 * unstyled.len());
}

/// A row whose mode byte is neither of the two defined values must be rejected,
/// not silently read as one of them.
#[test]
fn an_unknown_color_mode_is_rejected() {
    let mut encoded = vec![0xab, crate::cell::HAS_FG];
    encode_varint_u32(&mut encoded, u32::from('x'));
    encoded.push(7);
    let mut cells = cell_iter(&encoded);
    assert_eq!(cells.next(), Some(Err(CodecErr::InvalidColorMode)));
    assert_eq!(
        cells.next(),
        None,
        "the iterator fuses after a malformed row"
    );
}

/// A row of default-coloured cells never reads a colour, so the cell iterator
/// never looks at its mode byte. The validator refuses an unknown mode all the
/// same: the stream splitter cannot represent the row, and a frame one path
/// accepts and the other cannot carry is two formats.
#[test]
fn an_unknown_color_mode_is_refused_even_when_no_cell_reads_a_color() {
    let cells = vec![CellRepr::BLANK; 4];
    let header = link_test_header(4, 1);
    let mut encoded = Vec::new();
    encode_frame_into(
        &mut encoded,
        &header,
        std::iter::once(RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }),
    );
    let mode =
        crate::STREAM_HEADER_BYTES + crate::FRAME_HEADER_BODY_BYTES + crate::ROW_PREFIX_BYTES;
    assert_eq!(encoded[mode], crate::encode::COLOR_MODE_INDEXED);
    let validate = |frame: &[u8]| {
        validate_display_frame(
            frame,
            &mut Vec::new(),
            &mut Vec::new(),
            &mut Vec::new(),
            &mut Vec::new(),
            &mut Vec::new(),
        )
    };
    assert_eq!(validate(&encoded), Ok(header));
    for known in [
        crate::encode::COLOR_MODE_INDEXED,
        crate::encode::COLOR_MODE_LITERAL,
    ] {
        encoded[mode] = known;
        assert_eq!(validate(&encoded), Ok(header), "mode {known}");
    }
    for unknown in [2, 0x7f, 0xff] {
        encoded[mode] = unknown;
        assert_eq!(
            validate(&encoded),
            Err(DisplayFrameValidationError::Cell),
            "mode {unknown:#x}"
        );
    }
}

#[test]
fn blank_row_rles_to_tiny_payload() {
    // The blank a real terminal produces: an unstyled space carrying the
    // theme's default colors, which is exactly what the tag's default-color
    // omission exists to compress.
    let cells = vec![
        CellRepr {
            codepoint: u32::from(' '),
            ..CellRepr::BLANK
        };
        120
    ];
    let header = FrameHeader {
        memory_only: false,
        kind: FrameKind::Snapshot,
        cols: 120,
        rows: 1,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: 1,
        cursor_visible: 1,
        mode_flags: 0,
        row_count: 1,
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
    let mut encoded = Vec::new();
    encode_frame_into(
        &mut encoded,
        &header,
        [RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }]
        .into_iter(),
    );
    let row = iter_rows(&encoded).next().unwrap().unwrap();
    assert_eq!(
        row.cells.len(),
        4,
        "color mode + tag + codepoint + run length"
    );
}

#[test]
fn varint_decoder_accepts_only_canonical_u32_encodings() {
    for value in [0, 1, 127, 128, 16_383, 16_384, u32::MAX] {
        let mut encoded = Vec::new();
        encode_varint_u32(&mut encoded, value);
        let mut offset = 0;
        assert_eq!(decode_varint_u32(&encoded, &mut offset), Ok(value));
        assert_eq!(offset, encoded.len());
    }

    for invalid in [
        &[0x80, 0x00][..],
        &[0x81, 0x00][..],
        &[0xff, 0xff, 0xff, 0xff, 0x10][..],
        &[0xff, 0xff, 0xff, 0xff, 0x8f][..],
        &[0x80, 0x80, 0x80, 0x80, 0x80][..],
    ] {
        let mut offset = 0;
        assert_eq!(
            decode_varint_u32(invalid, &mut offset),
            Err(CodecErr::InvalidVarint),
            "{invalid:02x?}"
        );
    }
}

#[test]
fn cell_iterator_rejects_invalid_codepoints_and_unbounded_runs_then_fuses() {
    // Every row payload opens with its color mode byte.
    let mut invalid_codepoint = vec![crate::encode::COLOR_MODE_INDEXED, 0];
    encode_varint_u32(&mut invalid_codepoint, 0xd800);
    let mut cells = cell_iter(&invalid_codepoint);
    assert_eq!(cells.next(), Some(Err(CodecErr::InvalidCodepoint)));
    assert_eq!(cells.next(), None);

    for run_len in [0, u32::from(u16::MAX) + 1, u32::MAX] {
        let mut encoded = vec![crate::encode::COLOR_MODE_INDEXED, crate::cell::RLE];
        encode_varint_u32(&mut encoded, u32::from('x'));
        encode_varint_u32(&mut encoded, run_len);
        let mut cells = cell_iter(&encoded);
        assert_eq!(cells.next(), Some(Err(CodecErr::InvalidRunLength)));
        assert_eq!(cells.next(), None);
    }

    let mut encoded = vec![crate::encode::COLOR_MODE_INDEXED, crate::cell::RLE];
    encode_varint_u32(&mut encoded, u32::from('x'));
    encode_varint_u32(&mut encoded, u32::from(u16::MAX));
    encoded.push(0);
    encode_varint_u32(&mut encoded, u32::from('y'));
    let mut cells = cell_iter(&encoded);
    for _ in 0..u16::MAX {
        assert!(matches!(cells.next(), Some(Ok(_))));
    }
    assert_eq!(cells.next(), Some(Err(CodecErr::InvalidRunLength)));
    assert_eq!(cells.next(), None);
}

#[test]
fn row_iterator_stops_after_the_first_malformed_row() {
    let mut header = FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols: 80,
        rows: 24,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: 1,
        cursor_visible: 1,
        mode_flags: 0,
        row_count: 0,
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
    let mut encoded = Vec::new();
    encode_frame_into(&mut encoded, &header, core::iter::empty());
    header.row_count = u16::MAX;
    let row_count_offset = crate::DISPLAY_ROW_COUNT_OFFSET;
    encoded[row_count_offset..row_count_offset + 2]
        .copy_from_slice(&header.row_count.to_be_bytes());

    let mut rows = iter_rows(&encoded);
    assert_eq!(rows.next(), Some(Err(CodecErr::Truncated)));
    assert_eq!(rows.next(), None);

    let mut rows = crate::iter_rows_at(&encoded, usize::MAX, 1);
    assert_eq!(rows.next(), Some(Err(CodecErr::RowLengthOverflow)));
    assert_eq!(rows.next(), None);
}

#[test]
fn checked_encoder_never_truncates_row_prefix_fields() {
    let header = FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols: u16::MAX,
        rows: 1,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: 1,
        cursor_visible: 1,
        mode_flags: 0,
        row_count: 1,
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
    let blank = CellRepr::BLANK;
    let mut out = vec![0xa5];

    assert_eq!(
        try_encode_frame_into(
            &mut out,
            &header,
            [RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &[],
            }]
            .into_iter(),
        ),
        Err(EncodeError::EmptyRow)
    );
    assert!(out.is_empty());

    let too_many = vec![blank; usize::from(u16::MAX) + 1];
    assert_eq!(
        try_encode_frame_into(
            &mut out,
            &header,
            [RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &too_many,
            }]
            .into_iter(),
        ),
        Err(EncodeError::TooManyCells)
    );
    assert!(out.is_empty());

    assert_eq!(
        try_encode_frame_into(
            &mut out,
            &header,
            [RowRef {
                graphics: &[],
                row_index: 0,
                left: u16::MAX,
                cells: &[blank, blank],
            }]
            .into_iter(),
        ),
        Err(EncodeError::RowRangeOverflow)
    );
    assert!(out.is_empty());

    let mut invalid = blank;
    invalid.codepoint = 0xd800;
    assert_eq!(
        try_encode_frame_into(
            &mut out,
            &header,
            [RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &[invalid],
            }]
            .into_iter(),
        ),
        Err(EncodeError::InvalidCodepoint)
    );
    assert!(out.is_empty());

    let mut non_rle_cells = Vec::with_capacity(10_000);
    for index in 0..10_000u32 {
        non_rle_cells.push(CellRepr {
            codepoint: u32::from('!') + index % 90,
            fg: index.to_be_bytes()[1..4].try_into().unwrap(),
            bg: (!index).to_be_bytes()[1..4].try_into().unwrap(),
            ..blank
        });
    }
    assert_eq!(
        try_encode_frame_into(
            &mut out,
            &header,
            [RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &non_rle_cells,
            }]
            .into_iter(),
        ),
        Err(EncodeError::RowPayloadTooLarge)
    );
    assert!(out.is_empty());

    assert_eq!(
        try_encode_frame_into(&mut out, &header, core::iter::empty()),
        Err(EncodeError::RowCountMismatch)
    );
    assert!(out.is_empty());
}

fn link_test_header(cols: u16, row_count: u16) -> FrameHeader {
    FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols,
        rows: 4,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: 1,
        cursor_visible: 1,
        mode_flags: 0,
        row_count,
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
    }
}

/// A linked row's `left` carries the flag, its bytes open with the table, and
/// an unlinked row is byte-identical to the pre-link format.
#[test]
fn a_linked_row_flags_left_and_opens_with_its_span_table() {
    let mut cells = vec![CellRepr::BLANK; 5];
    for cell in &mut cells[1..3] {
        cell.link = 0x0102_0304;
    }
    let header = link_test_header(8, 1);
    let mut encoded = Vec::new();
    encode_frame_into(
        &mut encoded,
        &header,
        std::iter::once(RowRef {
            graphics: &[],
            row_index: 0,
            left: 3,
            cells: &cells,
        }),
    );
    let row = crate::STREAM_HEADER_BYTES + crate::FRAME_HEADER_BODY_BYTES;
    assert_eq!(&encoded[row + 2..row + 4], &(3u16 | crate::ROW_FLAG_LINKS).to_be_bytes());
    let table = row + crate::ROW_PREFIX_BYTES;
    assert_eq!(
        &encoded[table..table + 10],
        &[0, 1, 0, 1, 0, 2, 0x01, 0x02, 0x03, 0x04]
    );

    let unlinked = vec![CellRepr::BLANK; 5];
    let mut plain = Vec::new();
    encode_frame_into(
        &mut plain,
        &header,
        std::iter::once(RowRef {
            graphics: &[],
            row_index: 0,
            left: 3,
            cells: &unlinked,
        }),
    );
    assert_eq!(&plain[row + 2..row + 4], &3u16.to_be_bytes());
    assert_eq!(plain[row + crate::ROW_PREFIX_BYTES], 0, "color mode byte leads");
}

/// Every malformed table is refused before a cell of its row is applied: an
/// empty table, a span past the entry, overlapping or out-of-order spans, a
/// zero-length span, link id 0, and a count the row bytes cannot hold.
#[test]
fn malformed_link_tables_are_rejected() {
    let cells = vec![CellRepr::BLANK; 4];
    let header = link_test_header(4, 1);
    let mut encoded = Vec::new();
    encode_frame_into(
        &mut encoded,
        &header,
        std::iter::once(RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        }),
    );
    let row = crate::STREAM_HEADER_BYTES + crate::FRAME_HEADER_BODY_BYTES;
    let cell_bytes = encoded[row + crate::ROW_PREFIX_BYTES..].to_vec();

    let with_table = |table: &[u8]| {
        let mut frame = encoded[..row].to_vec();
        frame.extend_from_slice(&[0, 0]);
        frame.extend_from_slice(&crate::ROW_FLAG_LINKS.to_be_bytes());
        frame.extend_from_slice(&encoded[row + 4..row + 6]);
        frame.extend_from_slice(&((table.len() + cell_bytes.len()) as u16).to_be_bytes());
        frame.extend_from_slice(table);
        frame.extend_from_slice(&cell_bytes);
        frame
    };
    let span = |offset: u16, len: u16, link: u32| {
        let mut bytes = offset.to_be_bytes().to_vec();
        bytes.extend_from_slice(&len.to_be_bytes());
        bytes.extend_from_slice(&link.to_be_bytes());
        bytes
    };
    let table = |spans: &[Vec<u8>]| {
        let mut bytes = (spans.len() as u16).to_be_bytes().to_vec();
        for span in spans {
            bytes.extend_from_slice(span);
        }
        bytes
    };

    let valid = with_table(&table(&[span(0, 2, 7), span(2, 2, 8)]));
    let (mut rows, mut decoded, mut seen) = (Vec::new(), Vec::new(), Vec::new());
    validate_display_frame(
        &valid,
        &mut rows,
        &mut decoded,
        &mut seen,
        &mut Vec::new(),
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(
        decoded.iter().map(|cell| cell.link).collect::<Vec<_>>(),
        [7, 7, 8, 8]
    );

    let cases = [
        table(&[]),
        table(&[span(3, 2, 7)]),
        table(&[span(0, 3, 7), span(2, 1, 8)]),
        table(&[span(2, 1, 7), span(0, 1, 8)]),
        table(&[span(0, 0, 7)]),
        table(&[span(0, 1, 0)]),
        vec![0, 9],
    ];
    for case in cases {
        let frame = with_table(&case);
        let result = validate_display_frame(
            &frame,
            &mut rows,
            &mut decoded,
            &mut seen,
            &mut Vec::new(),
            &mut Vec::new(),
        );
        assert!(
            matches!(
                result,
                Err(DisplayFrameValidationError::LinkTable | DisplayFrameValidationError::Row)
            ),
            "{case:?} -> {result:?}"
        );
        let region = crate::validate_display_rows(
            header,
            &frame[row..],
            &mut rows,
            &mut decoded,
            &mut seen,
            &mut Vec::new(),
            &mut Vec::new(),
        );
        assert_eq!(region, result.map(|_| ()), "row region {case:?}");
    }
}
