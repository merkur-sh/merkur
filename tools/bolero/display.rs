use super::*;

mod seeds {
    include!("seeds.rs");
}

fn assert_released(terminal: &Terminal) {
    assert_eq!(terminal.staged_active_wire_bytes, 0);
    assert_eq!(terminal.staged_active_decoded_bytes, 0);
    assert_eq!(terminal.staged_active_decoded_cells, 0);
    assert!(terminal.staged_frames.iter().all(Option::is_none));
    assert!(terminal.display_decoded_rows.len() <= MAX_DISPLAY_FRAME_BYTES);
}


fn raw_seed() -> Vec<u8> {
    let cells = [test_cell('a'); 8];
    test_frame(
        FrameKind::Delta,
        8,
        RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &cells,
        },
    )
}

#[test]
fn fuzz_display_ingress() {
    let raw = raw_seed();
    let seeds = vec![
        ("encoder-raw-display", raw.clone()),
        ("encoder-compressed-display", compressed_test_frame(&raw)),
    ];
    seeds::persist(&seeds);
    let check = |bytes: &[u8]| {
        let mut terminal = Terminal::new(8, 1);
        let untouched = Terminal::new(8, 1);
        // Preflight and validation may use scratch, but cannot mutate any
        // authoritative cell, cursor, version or revision before apply.
        let handle = terminal.stage_display_frame_bytes(bytes);
        if handle != 0 {
            let _ = terminal.validate_staged_frame(handle);
            terminal.release_staged_frame(handle);
            terminal.release_staged_frame(handle);
        }
        assert_terminal_authority_eq(&terminal, &untouched, 8, 1);
        assert_released(&terminal);
        // Refused input cannot poison slot ownership or the reused decoder.
        let handle = terminal.stage_display_frame_bytes(&raw);
        assert_ne!(handle, 0);
        assert!(terminal.validate_staged_frame(handle));
        assert!(terminal.apply_staged_delta_seq(handle, 1));
        terminal.release_staged_frame(handle);
        assert_released(&terminal);
        let mut expected = Terminal::new(8, 1);
        assert!(expected.apply_delta_seq(&raw, 1));
        assert_terminal_authority_eq(&terminal, &expected, 8, 1);
    };
    for (_, seed) in &seeds {
        check(seed);
    }
    bolero::check!().with_max_len(4096).for_each(check);
}

#[test]
fn fuzz_display_mz() {
    let raw = raw_seed();
    let seed = compressed_test_frame(&raw);
    let seeds = vec![(
        "encoder-mz-payload",
        seed[DISPLAY_COMPRESSED_PAYLOAD_OFFSET..].to_vec(),
    )];
    seeds::persist(&seeds);
    let check = |bytes: &[u8]| {
        let mut wire = seed[..DISPLAY_COMPRESSED_PAYLOAD_OFFSET].to_vec();
        wire.extend_from_slice(bytes);
        restamp_test_body_len(&mut wire);
        let mut terminal = Terminal::new(8, 1);
        let untouched = Terminal::new(8, 1);
        let handle = terminal.stage_display_frame_bytes(&wire);
        if handle != 0 {
            assert!(terminal.validate_staged_frame(handle));
            let rows_len = raw.len() - STREAM_HEADER_BYTES - FRAME_HEADER_BODY_BYTES;
            let mut decoded = Vec::new();
            // A fresh receiver holds no rows and no epochs, as a fresh
            // terminal does.
            merkur_codec::mz::MzReceiver::default()
                .decode(1, 1, bytes, 1, rows_len, &mut decoded)
                .expect("an accepted payload decodes");
            assert_eq!(decoded.len(), rows_len);
            let mut plain = raw[..STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES].to_vec();
            plain.extend_from_slice(&decoded);
            restamp_test_body_len(&mut plain);
            let mut expected = Terminal::new(8, 1);
            assert!(expected.apply_delta_seq(&plain, 1));
            assert!(terminal.apply_staged_delta_seq(handle, 1));
            assert_terminal_authority_eq(&terminal, &expected, 8, 1);
            terminal.release_staged_frame(handle);
        } else {
            assert_terminal_authority_eq(&terminal, &untouched, 8, 1);
        }
        assert_released(&terminal);
        let handle = terminal.stage_display_frame_bytes(&seed);
        assert_ne!(handle, 0, "decoder must recover after rejection");
        terminal.release_staged_frame(handle);
        assert_released(&terminal);
    };
    for (_, seed) in &seeds {
        check(seed);
    }
    bolero::check!().with_max_len(4096).for_each(check);
}

#[test]
fn fuzz_display_roundtrip() {
    let seeds = vec![
        ("encoder-ascii-cells", b"display seed".to_vec()),
        ("encoder-color-cells", (0..=255).collect()),
    ];
    seeds::persist(&seeds);
    let check = |bytes: &[u8]| {
        let cells: Vec<_> = if bytes.is_empty() {
            vec![test_cell(' ')]
        } else {
            bytes
                .iter()
                .map(|byte| {
                    let mut cell = test_cell(char::from(b' ' + byte % 95));
                    cell.fg = [*byte, byte.rotate_left(2), byte.rotate_left(4)];
                    cell
                })
                .collect()
        };
        let cols = u16::try_from(cells.len()).expect("bounded cells");
        let raw = test_frame(
            FrameKind::Delta,
            cols,
            RowRef {
                graphics: &[],
                row_index: 0,
                left: 0,
                cells: &cells,
            },
        );
        let wire = compressed_test_frame(&raw);
        let mut plain = Terminal::new(cols, 1);
        let mut compressed = Terminal::new(cols, 1);
        for _ in 0..2 {
            assert!(plain.apply_delta_seq(&raw, 1));
            let handle = compressed.stage_display_frame_bytes(&wire);
            assert_ne!(handle, 0);
            assert!(compressed.validate_staged_frame(handle));
            assert!(compressed.apply_staged_delta_seq(handle, 1));
            compressed.release_staged_frame(handle);
            assert_released(&compressed);
        }
        assert_terminal_authority_eq(&plain, &compressed, cols, 1);
    };
    for (_, seed) in &seeds {
        check(seed);
    }
    bolero::check!().with_max_len(512).for_each(check);
}
