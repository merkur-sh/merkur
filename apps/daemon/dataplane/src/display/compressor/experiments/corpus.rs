//! Chronological, validated split payloads for standalone native codec research.

use super::*;
use std::io::Write;

const KINDS: [&str; 8] = [
    "logs",
    "scroll",
    "tui",
    "typing",
    "entropy",
    "switch",
    "scroll_edit",
    "unicode",
];

fn research_trace(kind: &str) -> Vec<Update> {
    if kind == "scroll_edit" {
        return trace_with_writer(|step| {
            let mut bytes = write_update("scroll", step);
            for row in 1..=ROWS {
                bytes.extend_from_slice(format!("\x1b[{row};1H{}", step % 10).as_bytes());
            }
            bytes
        });
    }
    if kind == "unicode" {
        return trace_with_writer(|step| {
            let mut bytes = b"\x1b[H".to_vec();
            for row in 1..=ROWS {
                bytes.extend_from_slice(
                    format!(
                        "\x1b[{row};1H\x1b[2K\x1b[38;2;80;160;220m文件 café λ 🚀 行={} 状态={} {}",
                        step + usize::from(row),
                        step % 10,
                        "终端".repeat(10),
                    )
                    .as_bytes(),
                );
            }
            bytes
        });
    }
    trace(kind)
}

#[derive(Default)]
struct Canonical {
    frame: Vec<u8>,
    splitter: merkur_codec::RowSplitter,
}

impl Canonical {
    fn screen(&mut self, screen: &[impl AsRef<[CellRepr]>]) -> &[u8] {
        self.frame.clear();
        merkur_codec::encode_frame_into(
            &mut self.frame,
            &header(screen.len()),
            screen.iter().enumerate().map(|(row, cells)| RowRef {
                row_index: u16::try_from(row).unwrap(),
                left: 0,
                cells: cells.as_ref(),
                graphics: &[],
            }),
        );
        self.splitter.split(&self.frame[BODY..], ROWS).unwrap()
    }

    fn cpu_us(&mut self, screen: &[impl AsRef<[CellRepr]>]) -> f64 {
        std::hint::black_box(self.screen(screen));
        let started = thread_cpu_time();
        for _ in 0..20 {
            std::hint::black_box(self.screen(screen));
        }
        (thread_cpu_time() - started).as_secs_f64() * 1e6 / 20.0
    }
}

fn word(out: &mut impl Write, value: usize) {
    out.write_all(&u32::try_from(value).unwrap().to_le_bytes())
        .unwrap();
}

fn blob(out: &mut impl Write, bytes: &[u8]) {
    word(out, bytes.len());
    out.write_all(bytes).unwrap();
}

fn compressed_overhead(frame: &[u8], dictionary: bool) -> usize {
    let mut envelope = frame[..BODY].to_vec();
    envelope[DISPLAY_HEADER_FLAGS_OFFSET] |= DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD;
    envelope.extend_from_slice(&0u32.to_be_bytes());
    if dictionary {
        envelope[DISPLAY_HEADER_FLAGS_OFFSET] |= DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT;
        envelope.extend_from_slice(&1u32.to_be_bytes());
        envelope.extend_from_slice(&1u32.to_be_bytes());
    }
    compact_len(&envelope)
}

fn export_case(out: &mut impl Write, kind: &str, timing: bool) {
    let updates = research_trace(kind);
    blob(out, kind.as_bytes());
    let samples = split_samples(&updates[..TRAIN]);
    let sources = [
        Vec::new(),
        screen_dictionary(&updates[TRAIN - 1].screen),
        history_dictionary(&samples, 4096),
        history_dictionary(&samples, 16384),
    ];
    let dictionaries: Vec<_> = sources
        .iter()
        .map(|bytes| (!bytes.is_empty()).then(|| DisplayDictionary::new(1, 1, bytes.clone())))
        .collect();
    for bytes in &sources {
        blob(out, bytes);
    }
    word(out, updates.len());
    let mut receiver = vec![vec![CellRepr::BLANK; usize::from(COLS)]; usize::from(ROWS)];
    let mut canonical = Canonical::default();
    let mut splitter = merkur_codec::RowSplitter::default();
    let mut decoder = Decoder::new(None);
    let mut compressor = Compressor::new();
    for update in &updates {
        for entries in &update.packets {
            let frame = packed(&mut compressor, entries, None);
            let decoded = decoder.decode(&frame);
            assert_entries(&decoded, entries);
            apply_entries(&mut receiver, &decoded);
        }
        for (actual, expected) in receiver.iter().zip(&update.screen) {
            assert_eq!(actual.as_slice(), expected.as_ref());
        }
        let sender_bytes = canonical.screen(&update.screen).to_vec();
        let receiver_bytes = canonical.screen(&receiver).to_vec();
        assert_eq!(sender_bytes, receiver_bytes);
        blob(out, &sender_bytes);
        blob(out, &receiver_bytes);
        let costs = if timing {
            [
                canonical.cpu_us(&update.screen),
                canonical.cpu_us(&receiver),
            ]
        } else {
            [0.0, 0.0]
        };
        for cost in costs {
            out.write_all(&cost.to_le_bytes()).unwrap();
        }
        word(out, update.packets.len());
        for entries in &update.packets {
            let frame = encode(entries);
            let split = splitter
                .split(&frame[BODY..], u16::try_from(entries.len()).unwrap())
                .unwrap();
            word(out, entries.len());
            blob(out, &frame[BODY..]);
            blob(out, split);
            word(out, compact_len(&frame));
            word(out, compressed_overhead(&frame, false));
            word(out, compressed_overhead(&frame, true));
            for dictionary in &dictionaries {
                word(
                    out,
                    compact_len(&packed(&mut compressor, entries, dictionary.as_ref())),
                );
            }
        }
    }
}

#[test]
fn checkpoint_canonical_bytes_follow_independently_decoded_grids() {
    for kind in KINDS {
        export_case(&mut std::io::sink(), kind, false);
    }
}

#[test]
#[ignore = "export validated payloads for standalone codec comparisons"]
fn export_codec_corpus() {
    let path = std::env::var("MERKUR_CODEC_CORPUS").expect("MERKUR_CODEC_CORPUS output path");
    let mut out = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    out.write_all(b"MERKUR-CODEC-CORPUS\0").unwrap();
    word(&mut out, KINDS.len());
    word(&mut out, TRAIN);
    word(&mut out, 4 + crate::e2e::FRAME_OVERHEAD);
    word(&mut out, 2 * (12 + 4 + crate::e2e::FRAME_OVERHEAD));
    word(&mut out, install_cost(1) - 1);
    for kind in KINDS {
        export_case(&mut out, kind, true);
    }
    out.flush().unwrap();
}
