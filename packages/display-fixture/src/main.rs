//! Reads a raw display row body on stdin and writes its compressed payload to
//! stdout: the MZ coding of the rows, literal entries only, as the dataplane
//! display path codes a frame with no acknowledged rows to reference. The
//! browser decoder benchmarks therefore measure the same payload the daemon
//! sends. The row count is read from the body itself, whose rows are
//! length-prefixed.

use std::io::{Read, Write};

fn main() {
    if let Some(argument) = std::env::args().nth(1) {
        exit_with_error(&format!("unexpected argument {argument}"));
    }
    let mut input = Vec::new();
    if let Err(error) = std::io::stdin().read_to_end(&mut input) {
        exit_with_error(&format!("failed to read stdin: {error}"));
    }
    let payload = match compress(&input) {
        Ok(payload) => payload,
        Err(error) => exit_with_error(&format!("compression failed: {error}")),
    };
    if let Err(error) = std::io::stdout().lock().write_all(&payload) {
        exit_with_error(&format!("failed to write stdout: {error}"));
    }
}

/// How many rows a row-layout body holds. Each row is its 8-byte prefix, the
/// byte count its prefix declares, and a length-prefixed graphics section when
/// its `left` field carries the graphics flag.
fn row_count(body: &[u8]) -> Result<u16, String> {
    let invalid = || String::from("not a row body");
    let mut rows = 0u16;
    let mut at = 0usize;
    while at < body.len() {
        let prefix = body
            .get(at..at + merkur_codec::ROW_PREFIX_BYTES)
            .ok_or_else(invalid)?;
        let left = u16::from_be_bytes([prefix[2], prefix[3]]);
        at += merkur_codec::ROW_PREFIX_BYTES
            + usize::from(u16::from_be_bytes([prefix[6], prefix[7]]));
        if left & merkur_codec::ROW_FLAG_GRAPHICS != 0 {
            let length = body.get(at..at + 4).ok_or_else(invalid)?;
            at += 4 + u32::from_be_bytes([length[0], length[1], length[2], length[3]]) as usize;
        }
        if at > body.len() {
            return Err(invalid());
        }
        rows = rows.checked_add(1).ok_or("too many rows")?;
    }
    Ok(rows)
}

fn compress(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut payload = Vec::new();
    merkur_codec::mz::MzEncoder::default()
        .encode_rows(
            body,
            row_count(body)?,
            &merkur_codec::mz::NoHistory,
            None,
            None,
            &mut payload,
        )
        .ok_or("the rows do not code")?;
    Ok(payload)
}

fn exit_with_error(message: &str) -> ! {
    eprintln!("display-fixture: {message}");
    std::process::exit(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row body of `rows` text rows, as the daemon encodes it.
    fn body(rows: usize) -> Vec<u8> {
        let lines: Vec<Vec<merkur_codec::CellRepr>> = (0..rows)
            .map(|row| {
                format!("INFO terminal row {row:03} merkur prompt shell output repeated history")
                    .chars()
                    .map(|c| merkur_codec::CellRepr {
                        codepoint: c as u32,
                        ..merkur_codec::CellRepr::BLANK
                    })
                    .collect()
            })
            .collect();
        let header = merkur_codec::FrameHeader {
            memory_only: false,
            kind: merkur_codec::FrameKind::Delta,
            cols: 120,
            rows: 40,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: 1,
            cursor_visible: 1,
            mode_flags: 0,
            row_count: u16::try_from(rows).expect("a grid of rows"),
            frame_id: 1,
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
        let mut frame = Vec::new();
        let graphics = merkur_codec::PreparedGraphics::default();
        let mut encoder = merkur_codec::mz::MzEncoder::default();
        let metadata = encoder.encode_prepared_frame_into(
            &mut frame,
            &header,
            lines
                .iter()
                .enumerate()
                .map(|(row, cells)| merkur_codec::PreparedRowRef {
                    graphics: &graphics,
                    row_index: u16::try_from(row).expect("a grid row"),
                    left: 0,
                    cells,
                    encoding: merkur_codec::plan_cell_encoding(cells).1,
                }),
        );
        let body =
            &frame[merkur_codec::STREAM_HEADER_BYTES + merkur_codec::FRAME_HEADER_BODY_BYTES..];
        let mut payload = Vec::new();
        encoder
            .encode_prepared(
                body,
                metadata,
                &merkur_codec::mz::NoHistory,
                None,
                None,
                &mut payload,
            )
            .expect("prepared fixture codes");
        assert_eq!(payload, compress(body).expect("pre-encoded fixture codes"));
        body.to_vec()
    }

    #[test]
    fn payloads_round_trip_and_shrink() {
        let rows = body(32);
        let payload = compress(&rows).unwrap();
        assert!(payload.len() < rows.len());
        let mut decoded = Vec::new();
        merkur_codec::mz::MzReceiver::default()
            .decode(1, 1, 1, &payload, 32, rows.len(), &mut decoded)
            .unwrap();
        assert_eq!(decoded, rows);
    }

    #[test]
    fn a_body_that_is_not_rows_is_refused() {
        assert!(compress(&[1, 2, 3]).is_err());
    }

    /// The fixture row counts the browser's receiver calibration measures.
    const CALIBRATION_ROWS: [u16; 6] = [1, 2, 4, 8, 16, 29];
    const CALIBRATION_COLS: u16 = 120;
    /// The row layout's indexed colour mode (`DISPLAY_COLOR_MODE_INDEXED`).
    const COLOR_MODE_INDEXED: u8 = 0;

    /// The first `rows` rows of the calibration frame, exactly as
    /// `createCalibrationFrame` in the receiver calibration writes them.
    fn calibration_rows(rows: u16) -> Vec<u8> {
        let cell_bytes = 1 + usize::from(CALIBRATION_COLS) * 2;
        let mut body = Vec::new();
        for row in 0..rows {
            body.extend_from_slice(&row.to_be_bytes());
            body.extend_from_slice(&0u16.to_be_bytes());
            body.extend_from_slice(&CALIBRATION_COLS.to_be_bytes());
            body.extend_from_slice(
                &u16::try_from(cell_bytes)
                    .expect("a calibration row")
                    .to_be_bytes(),
            );
            body.push(COLOR_MODE_INDEXED);
            for col in 0..CALIBRATION_COLS {
                body.push(0);
                body.push(0x20 + ((row + col) & 0x3f) as u8);
            }
        }
        body
    }

    fn calibration_fixtures_source() -> String {
        use std::fmt::Write;
        let mut source = String::from(
            "// Generated by `the_calibration_fixtures_are_the_models_coding` in\n\
             // packages/display-fixture; do not edit. Each block is the MZ payload, base64, of the\n\
             // receiver calibration frame's first `rows` rows (`createCalibrationFrame`), coded\n\
             // with the model compiled into both ends.\n\
             export const CALIBRATION_FIXTURES: readonly {\n  readonly rows: number;\n  readonly block: string;\n}[] = [\n",
        );
        for rows in CALIBRATION_ROWS {
            let payload = compress(&calibration_rows(rows)).expect("calibration rows code");
            writeln!(
                source,
                "  {{\n    rows: {rows},\n    block:\n      '{}',\n  }},",
                base64(&payload)
            )
            .expect("write to a string");
        }
        source.push_str("];\n");
        source
    }

    fn base64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let word = u32::from(chunk[0]) << 16
                | u32::from(chunk.get(1).copied().unwrap_or(0)) << 8
                | u32::from(chunk.get(2).copied().unwrap_or(0));
            for index in 0..4 {
                if index <= chunk.len() {
                    out.push(char::from(
                        ALPHABET[(word >> (18 - 6 * index) & 0x3f) as usize],
                    ));
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    /// The full-grid rows the terminal worker's display-owner test builds for
    /// `marker` (`fullGridRows` and `encodeRow` there), and their row count.
    fn owner_grid_rows(marker: char) -> (Vec<u8>, u16) {
        let mut body = Vec::new();
        for row in 0..OWNER_GRID_ROWS {
            let mut text: Vec<char> = format!("{marker}-{row:02x}").chars().collect();
            text.resize(usize::from(OWNER_GRID_COLS), marker);
            let mut cells = vec![COLOR_MODE_INDEXED];
            let mut index = 0;
            while index < text.len() {
                let mut run = 1;
                while index + run < text.len() && text[index + run] == text[index] {
                    run += 1;
                }
                cells.push(if run > 1 { 0x80 } else { 0 });
                merkur_codec::encode_varint_u32(&mut cells, u32::from(text[index]));
                if run > 1 {
                    merkur_codec::encode_varint_u32(
                        &mut cells,
                        u32::try_from(run).expect("a run within a row"),
                    );
                }
                index += run;
            }
            body.extend_from_slice(&row.to_be_bytes());
            body.extend_from_slice(&0u16.to_be_bytes());
            body.extend_from_slice(&OWNER_GRID_COLS.to_be_bytes());
            body.extend_from_slice(
                &u16::try_from(cells.len())
                    .expect("a grid row")
                    .to_be_bytes(),
            );
            body.extend_from_slice(&cells);
        }
        (body, OWNER_GRID_ROWS)
    }

    /// `MAX_TERMINAL_ROWS` rows of `MAX_TERMINAL_CELLS / MAX_TERMINAL_ROWS`
    /// columns: the display-owner test's maximal grid.
    #[expect(
        clippy::cast_possible_truncation,
        reason = "256 rows of 384 columns, both well inside a `u16`"
    )]
    const OWNER_GRID_ROWS: u16 = merkur_codec::MAX_TERMINAL_ROWS as u16;
    #[expect(
        clippy::cast_possible_truncation,
        reason = "256 rows of 384 columns, both well inside a `u16`"
    )]
    const OWNER_GRID_COLS: u16 =
        (merkur_codec::MAX_TERMINAL_CELLS / merkur_codec::MAX_TERMINAL_ROWS) as u16;

    fn owner_grids_json() -> String {
        let grids: Vec<String> = ['a', 'b', 'c']
            .into_iter()
            .map(|marker| {
                let (rows, count) = owner_grid_rows(marker);
                assert_eq!(row_count(&rows), Ok(count));
                let payload = compress(&rows).expect("the grid codes");
                format!(
                    "    {{\n      \"marker\": \"{marker}\",\n      \"rowsLength\": {},\n      \"payload\": \"{}\"\n    }}",
                    rows.len(),
                    base64(&payload)
                )
            })
            .collect();
        format!(
            "{{\n  \"cols\": {OWNER_GRID_COLS},\n  \"rows\": {OWNER_GRID_ROWS},\n  \"grids\": [\n{}\n  ]\n}}\n",
            grids.join(",\n")
        )
    }

    fn owner_grids_path() -> std::path::PathBuf {
        std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").expect("test manifest directory"),
        )
        .join("../shared/test-vectors/display-mz-grids.json")
    }

    /// The MZ payloads the terminal worker's display-owner test stages must
    /// be what the model codes today. Rewrite them with
    /// `MERKUR_WRITE_CALIBRATION_FIXTURES=1`.
    #[test]
    fn the_display_owner_grids_are_the_models_coding() {
        let expected = owner_grids_json();
        if std::env::var("MERKUR_WRITE_CALIBRATION_FIXTURES").is_ok() {
            std::fs::write(owner_grids_path(), &expected).expect("write the vector");
        }
        let committed =
            std::fs::read_to_string(owner_grids_path()).expect("the grid vector is committed");
        assert_eq!(
            committed, expected,
            "the display-owner grids drifted from the model"
        );
    }

    fn calibration_fixtures_path() -> std::path::PathBuf {
        std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").expect("test manifest directory"),
        )
        .join("../../apps/web/src/terminal/display-receiver-calibration-fixtures.ts")
    }

    /// The calibration's compressed fixtures must be what the model codes
    /// today: a retrained model changes every block, and a stale block fails
    /// the browser's calibration. Rewrite them with
    /// `MERKUR_WRITE_CALIBRATION_FIXTURES=1`.
    #[test]
    fn the_calibration_fixtures_are_the_models_coding() {
        let expected = calibration_fixtures_source();
        if std::env::var("MERKUR_WRITE_CALIBRATION_FIXTURES").is_ok() {
            std::fs::write(calibration_fixtures_path(), &expected).expect("write the fixtures");
        }
        let committed = std::fs::read_to_string(calibration_fixtures_path())
            .expect("the calibration fixtures are committed");
        assert_eq!(
            committed, expected,
            "the calibration fixtures drifted from the model"
        );
    }
}
