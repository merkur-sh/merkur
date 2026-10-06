//! Reads a raw display row body on stdin and writes its compressed payload to
//! stdout: the zstd frame of the rows' split layout, magicless and without a
//! frame content size. This mirrors what the dataplane display path produces,
//! so the browser decoder benchmarks measure the same payload the daemon sends.
//! The row count is read from the body itself, whose rows are length-prefixed.
//!
//! `--dictionary-bytes=N` treats the first `N` stdin bytes as an external
//! dictionary and the remainder as the row body. In that mode stdout starts
//! with the dictionary's four-byte big-endian protocol hash, followed by the
//! dictionary-compressed payload. Keeping both inputs on stdin avoids a
//! benchmark-only temporary-file path.
//!
//! `--make-dictionary --max-dictionary-bytes=N` trains a dictionary capped at
//! `N` bytes from a row body, sampled as frames carry it: consecutive rows
//! grouped to one datagram's worth of row bytes, each group split on its own.
//! The cap lets browser calibration embed the real format without carrying the
//! much larger training corpus into production.

use std::io::{Read, Write};

/// One datagram's worth of row bytes, the unit frames carry and dictionaries
/// are sampled at (`DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES` in the daemon).
const SAMPLE_ROW_BYTES: usize = 1100;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let make_dictionary = args.iter().any(|argument| argument == "--make-dictionary");
    let max_dictionary_bytes = match parse_max_dictionary_bytes(args.iter().cloned()) {
        Ok(max_dictionary_bytes) => max_dictionary_bytes,
        Err(error) => exit_with_error(&error),
    };
    if max_dictionary_bytes.is_some() && !make_dictionary {
        exit_with_error("--max-dictionary-bytes requires --make-dictionary");
    }
    let dictionary_bytes = match parse_dictionary_bytes(
        args.iter()
            .filter(|argument| {
                *argument != "--make-dictionary" && !argument.starts_with("--max-dictionary-bytes=")
            })
            .cloned(),
    ) {
        Ok(dictionary_bytes) => dictionary_bytes,
        Err(error) => exit_with_error(&error),
    };
    let mut input = Vec::new();
    if let Err(error) = std::io::stdin().read_to_end(&mut input) {
        eprintln!("zstd-fixture: failed to read stdin: {error}");
        std::process::exit(1);
    }

    if make_dictionary {
        let dictionary = match build_dictionary(&input, max_dictionary_bytes.unwrap_or(input.len()))
        {
            Ok(dictionary) => dictionary,
            Err(error) => exit_with_error(&format!("dictionary training failed: {error}")),
        };
        if let Err(error) = std::io::stdout().lock().write_all(&dictionary) {
            exit_with_error(&format!("failed to write stdout: {error}"));
        }
        return;
    }

    let (dictionary, payload) = match split_input(&input, dictionary_bytes) {
        Ok(parts) => parts,
        Err(error) => exit_with_error(&error),
    };
    let compressed = match compress(payload, dictionary) {
        Ok(compressed) => compressed,
        Err(error) => exit_with_error(&format!("compression failed: {error}")),
    };

    let mut stdout = std::io::stdout().lock();
    if let Some(dictionary) = dictionary {
        let hash = (merkur_codec::hash_bytes(dictionary) >> 32) as u32;
        if let Err(error) = stdout.write_all(&hash.to_be_bytes()) {
            exit_with_error(&format!("failed to write dictionary hash: {error}"));
        }
    }
    if let Err(error) = stdout.write_all(&compressed) {
        exit_with_error(&format!("failed to write stdout: {error}"));
    }
}

fn parse_max_dictionary_bytes(
    args: impl IntoIterator<Item = String>,
) -> Result<Option<usize>, String> {
    let mut max_dictionary_bytes = None;
    for argument in args {
        let Some(value) = argument.strip_prefix("--max-dictionary-bytes=") else {
            continue;
        };
        if max_dictionary_bytes.is_some() {
            return Err(String::from(
                "--max-dictionary-bytes may only be provided once",
            ));
        }
        let parsed = value
            .parse::<usize>()
            .map_err(|_| String::from("--max-dictionary-bytes must be a positive integer"))?;
        if parsed == 0 {
            return Err(String::from(
                "--max-dictionary-bytes must be a positive integer",
            ));
        }
        max_dictionary_bytes = Some(parsed);
    }
    Ok(max_dictionary_bytes)
}

fn parse_dictionary_bytes(args: impl IntoIterator<Item = String>) -> Result<Option<usize>, String> {
    let mut dictionary_bytes = None;
    for argument in args {
        let Some(value) = argument.strip_prefix("--dictionary-bytes=") else {
            return Err(format!("unknown argument {argument:?}"));
        };
        if dictionary_bytes.is_some() {
            return Err(String::from("--dictionary-bytes may only be provided once"));
        }
        let parsed = value
            .parse::<usize>()
            .map_err(|_| String::from("--dictionary-bytes must be a positive integer"))?;
        if parsed == 0 {
            return Err(String::from(
                "--dictionary-bytes must be a positive integer",
            ));
        }
        dictionary_bytes = Some(parsed);
    }
    Ok(dictionary_bytes)
}

fn split_input(
    input: &[u8],
    dictionary_bytes: Option<usize>,
) -> Result<(Option<&[u8]>, &[u8]), String> {
    let Some(dictionary_bytes) = dictionary_bytes else {
        return Ok((None, input));
    };
    if dictionary_bytes >= input.len() {
        return Err(format!(
            "--dictionary-bytes={dictionary_bytes} leaves no payload in {} stdin bytes",
            input.len()
        ));
    }
    let (dictionary, payload) = input.split_at(dictionary_bytes);
    Ok((Some(dictionary), payload))
}

/// The end of every row of a row-layout body, in order. Each row is its
/// 8-byte prefix, the byte count its prefix declares, and a length-prefixed
/// graphics section when its `left` field carries the graphics flag.
fn row_ends(body: &[u8]) -> Result<Vec<usize>, std::io::Error> {
    let invalid = || std::io::Error::new(std::io::ErrorKind::InvalidData, "not a row body");
    let mut ends = Vec::new();
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
        ends.push(at);
    }
    Ok(ends)
}

/// The split layout of a whole row body.
fn split_body(body: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    let rows = u16::try_from(row_ends(body)?.len())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "too many rows"))?;
    merkur_codec::RowSplitter::default()
        .split(body, rows)
        .map(<[u8]>::to_vec)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, format!("{error:?}")))
}

/// Train a dictionary from a row body, sampled as frames carry it.
///
/// `install_display_dictionary` refuses anything the decoder cannot parse, so a
/// benchmark cannot hand the terminal an arbitrary byte string. This produces a
/// valid dictionary of the requested shape; it is not a byte-identical
/// reproduction of the daemon's `finalize_display_dictionary` output, which the
/// dataplane's own calibration test covers.
fn build_dictionary(body: &[u8], max_dictionary_bytes: usize) -> Result<Vec<u8>, std::io::Error> {
    let ends = row_ends(body)?;
    let (mut samples, mut sizes) = (Vec::new(), Vec::new());
    let (mut start, mut previous_end, mut rows) = (0usize, 0usize, 0u16);
    let mut splitter = merkur_codec::RowSplitter::default();
    let mut push = |group: &[u8], rows: u16| -> Result<(), std::io::Error> {
        let split = splitter.split(group, rows).map_err(|error| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("{error:?}"))
        })?;
        if split.len() >= 64 {
            samples.extend_from_slice(split);
            sizes.push(split.len());
        }
        Ok(())
    };
    for end in ends {
        if rows > 0 && end - start > SAMPLE_ROW_BYTES {
            push(&body[start..previous_end], rows)?;
            start = previous_end;
            rows = 0;
        }
        rows += 1;
        previous_end = end;
    }
    if rows > 0 {
        push(&body[start..previous_end], rows)?;
    }
    zstd::dict::from_continuous(&samples, &sizes, max_dictionary_bytes)
}

/// Must stay at the level the daemon compresses display frames with, or the
/// browser benchmark measures a payload production never sends.
const DISPLAY_COMPRESSION_LEVEL: i32 = 3;

/// A context writing the display payload's zstd frame, as the daemon's does.
fn display_compressor(
    dictionary: Option<&[u8]>,
) -> Result<zstd::bulk::Compressor<'static>, std::io::Error> {
    use zstd::zstd_safe::{CParameter, FrameFormat};
    let mut compressor = match dictionary {
        Some(dictionary) => {
            zstd::bulk::Compressor::with_dictionary(DISPLAY_COMPRESSION_LEVEL, dictionary)?
        }
        None => zstd::bulk::Compressor::new(DISPLAY_COMPRESSION_LEVEL)?,
    };
    compressor.set_parameter(CParameter::Format(FrameFormat::Magicless))?;
    compressor.set_parameter(CParameter::ContentSizeFlag(false))?;
    Ok(compressor)
}

fn compress(body: &[u8], dictionary: Option<&[u8]>) -> Result<Vec<u8>, std::io::Error> {
    display_compressor(dictionary)?.compress(&split_body(body)?)
}

fn exit_with_error(message: &str) -> ! {
    eprintln!("zstd-fixture: {message}");
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
            row_count: rows as u16,
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
        merkur_codec::encode_frame_into(
            &mut frame,
            &header,
            lines
                .iter()
                .enumerate()
                .map(|(row, cells)| merkur_codec::RowRef {
                    graphics: &[],
                    row_index: row as u16,
                    left: 0,
                    cells,
                }),
        );
        frame[merkur_codec::STREAM_HEADER_BYTES + merkur_codec::FRAME_HEADER_BODY_BYTES..].to_vec()
    }

    fn decode(payload: &[u8], dictionary: Option<&[u8]>, rows: u16) -> Vec<u8> {
        use zstd::zstd_safe::{DCtx, DParameter, FrameFormat};
        let mut context = DCtx::create();
        context
            .set_parameter(DParameter::Format(FrameFormat::Magicless))
            .unwrap();
        if let Some(dictionary) = dictionary {
            context.load_dictionary(dictionary).unwrap();
        }
        let mut split = Vec::with_capacity(1 << 16);
        context.decompress(&mut split, payload).unwrap();
        let mut joined = Vec::new();
        merkur_codec::join_rows_into(&split, rows, &mut joined).unwrap();
        joined
    }

    #[test]
    fn payloads_round_trip_with_and_without_a_trained_dictionary() {
        let rows = body(6);
        let dictionary = build_dictionary(&body(240), 4096).unwrap();
        for dictionary in [None, Some(dictionary.as_slice())] {
            let payload = compress(&rows, dictionary).unwrap();
            assert_ne!(payload[..4], [0x28, 0xb5, 0x2f, 0xfd], "magicless");
            assert_eq!(decode(&payload, dictionary, 6), rows);
        }
    }

    #[test]
    fn a_body_that_is_not_rows_is_refused() {
        assert!(compress(b"not a display row body at all", None).is_err());
    }

    #[test]
    fn dictionary_input_split_requires_both_dictionary_and_payload() {
        assert_eq!(
            split_input(b"dictpayload", Some(4)).unwrap(),
            (Some(&b"dict"[..]), &b"payload"[..])
        );
        assert!(split_input(b"dict", Some(4)).is_err());
        assert!(split_input(b"dict", Some(5)).is_err());
    }

    #[test]
    fn dictionary_argument_is_exact_and_single() {
        assert_eq!(
            parse_dictionary_bytes([String::from("--dictionary-bytes=16")]).unwrap(),
            Some(16)
        );
        assert!(parse_dictionary_bytes([String::from("--dictionary-bytes=0")]).is_err());
        assert!(
            parse_dictionary_bytes([
                String::from("--dictionary-bytes=1"),
                String::from("--dictionary-bytes=2")
            ])
            .is_err()
        );
        assert!(parse_dictionary_bytes([String::from("--dictionary=1")]).is_err());
    }

    #[test]
    fn dictionary_training_limit_is_positive_and_single() {
        assert_eq!(
            parse_max_dictionary_bytes([String::from("--max-dictionary-bytes=1024")]).unwrap(),
            Some(1024)
        );
        assert!(parse_max_dictionary_bytes([String::from("--max-dictionary-bytes=0")]).is_err());
        assert!(
            parse_max_dictionary_bytes([
                String::from("--max-dictionary-bytes=512"),
                String::from("--max-dictionary-bytes=1024")
            ])
            .is_err()
        );
    }
}
