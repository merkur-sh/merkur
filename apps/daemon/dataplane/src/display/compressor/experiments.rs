//! Component experiments over chronologically separated terminal traces.
//! Packet membership is fixed across representations. This does not model
//! QUIC scheduling, FEC, GPU presentation, or real acknowledgment timing.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use merkur_codec::{CellRepr, FrameHeader, FrameKind, RowRef};

use super::*;
use crate::pty::{RowCaptureScratch, TerminalState};

const COLS: u16 = 120;
const ROWS: u16 = 40;
const TRAIN: usize = 24;
const STEPS: usize = 88;
const BODY: usize = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
/// A test-only record tag, counted in addition to the inner display header.
const REUSE_TAG: u8 = 0xfe;
/// Immutable fixture inputs, shared by both arms. Receiver checkpoint
/// retention is measured separately from this common corpus.
type Screen = Vec<Arc<[CellRepr]>>;

#[derive(Clone)]
struct Entry {
    row: u16,
    left: u16,
    cells: Arc<[CellRepr]>,
}

struct Update {
    screen: Screen,
    hashes: Vec<u64>,
    packets: Vec<Vec<Entry>>,
}

fn header(count: usize) -> FrameHeader {
    FrameHeader {
        kind: FrameKind::Delta,
        memory_only: false,
        cols: COLS,
        rows: ROWS,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: 1,
        cursor_visible: 1,
        mode_flags: 0,
        row_count: u16::try_from(count).unwrap(),
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
    }
}

fn encode(entries: &[Entry]) -> Vec<u8> {
    let mut out = Vec::new();
    merkur_codec::encode_frame_into(
        &mut out,
        &header(entries.len()),
        entries.iter().map(|e| RowRef {
            row_index: e.row,
            left: e.left,
            cells: &e.cells,
            graphics: &[],
        }),
    );
    out[0] = MSG_TYPE_DISPLAY_PATCH;
    out
}

fn snapshot(screen: &Screen) -> Vec<Entry> {
    screen
        .iter()
        .enumerate()
        .map(|(row, cells)| Entry {
            row: u16::try_from(row).unwrap(),
            left: 0,
            cells: Arc::clone(cells),
        })
        .collect()
}

fn delta(old: &Screen, new: &Screen) -> Vec<Entry> {
    new.iter()
        .enumerate()
        .filter_map(|(row, cells)| {
            let before = &old[row];
            let left = before.iter().zip(cells.iter()).position(|(a, b)| a != b)?;
            let right = before
                .iter()
                .zip(cells.iter())
                .rposition(|(a, b)| a != b)
                .unwrap()
                + 1;
            Some(Entry {
                row: u16::try_from(row).unwrap(),
                left: u16::try_from(left).unwrap(),
                cells: Arc::from(&cells[left..right]),
            })
        })
        .collect()
}

fn packets(entries: Vec<Entry>) -> Vec<Vec<Entry>> {
    // A conservative raw-size packetization, shared by every arm. It is not
    // the production adaptive partitioner: an experiment cannot attribute its
    // packet count or planning cost to that implementation.
    let mut out = Vec::new();
    let mut group = Vec::new();
    let mut bytes = merkur_codec::wire::MAX_UNCHUNKED_WIRE_HEADER_BYTES;
    for entry in entries {
        let size = merkur_codec::ROW_PREFIX_BYTES + merkur_codec::encoded_cells_size(&entry.cells);
        if !group.is_empty()
            && bytes + size
                > super::super::policy::DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES
        {
            out.push(std::mem::take(&mut group));
            bytes = merkur_codec::wire::MAX_UNCHUNKED_WIRE_HEADER_BYTES;
        }
        bytes += size;
        group.push(entry);
    }
    if !group.is_empty() {
        out.push(group);
    }
    out
}

fn write_update(kind: &str, step: usize) -> Vec<u8> {
    let kind = if kind == "switch" {
        if step < TRAIN { "logs" } else { "entropy" }
    } else {
        kind
    };
    if kind == "typing" {
        return format!("\x1b[1;1H\x1b[2Kuser@host$ {}", "abcdef".repeat(step % 16)).into_bytes();
    }
    let mut bytes = b"\x1b[H".to_vec();
    for row in 0..usize::from(ROWS) {
        let id = if kind == "scroll" || kind == "logs" {
            step + row
        } else {
            row
        };
        bytes.extend_from_slice(format!("\x1b[{};1H\x1b[2K", row + 1).as_bytes());
        if kind == "logs" {
            bytes.extend_from_slice(format!("INFO request={id:06} service=terminal elapsed={}us status=ok device=workstation", id % 997).as_bytes());
        } else if kind == "tui" {
            bytes.extend_from_slice(
                format!(
                    "\x1b[38;2;80;160;220m{:04}  src/display/module_{row}.rs  state={}  {}",
                    row + 1,
                    step % 10,
                    "fn render() { update_grid(); } ".repeat(2)
                )
                .as_bytes(),
            );
        } else {
            let mut random = (u32::try_from(id).unwrap() + 1).wrapping_mul(0x9e3779b9)
                ^ if kind == "entropy" {
                    u32::try_from(step).unwrap()
                } else {
                    0
                };
            for col in 0..100 {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                if col % 8 == 0 {
                    bytes.extend_from_slice(
                        format!(
                            "\x1b[38;2;{};{};{}m",
                            random & 255,
                            (random >> 8) & 255,
                            (random >> 16) & 255
                        )
                        .as_bytes(),
                    );
                }
                bytes.push(b'!' + u8::try_from(random % 90).unwrap());
            }
        }
        bytes.extend_from_slice(b"\x1b[0m");
    }
    bytes
}

fn trace(kind: &str) -> Vec<Update> {
    let mut terminal = TerminalState::new(COLS, ROWS, crossbeam_channel::unbounded().0);
    let mut scratch = RowCaptureScratch::default();
    let mut old: Screen = (0..ROWS)
        .map(|row| terminal.capture_row(row, &mut scratch).cells)
        .collect();
    (0..STEPS)
        .map(|step| {
            terminal.apply_bytes(&write_update(kind, step));
            let captured: Vec<_> = (0..ROWS)
                .map(|row| terminal.capture_row(row, &mut scratch))
                .collect();
            let hashes = captured.iter().map(|row| row.hash).collect();
            let screen: Screen = captured.into_iter().map(|row| row.cells).collect();
            let entries = if step == 0 {
                snapshot(&screen)
            } else {
                delta(&old, &screen)
            };
            old = screen.clone();
            Update {
                screen,
                hashes,
                packets: packets(entries),
            }
        })
        .collect()
}

fn split_samples(updates: &[Update]) -> Vec<Vec<u8>> {
    let mut splitter = merkur_codec::RowSplitter::default();
    updates
        .iter()
        .flat_map(|u| &u.packets)
        .filter_map(|packet| {
            let frame = encode(packet);
            let split = splitter
                .split(&frame[BODY..], u16::try_from(packet.len()).unwrap())
                .unwrap();
            (split.len() >= DISPLAY_DICTIONARY_SAMPLE_MIN_BYTES).then(|| split.to_vec())
        })
        .collect()
}

fn history_dictionary(samples: &[Vec<u8>], cap: usize) -> Vec<u8> {
    if samples.is_empty() {
        return Vec::new();
    }
    let content: Vec<u8> = samples.iter().flatten().copied().collect();
    finalize_content(&content, samples, cap)
}

fn finalize_content(content: &[u8], samples: &[Vec<u8>], cap: usize) -> Vec<u8> {
    if content.is_empty() || samples.is_empty() {
        return Vec::new();
    }
    let all: Vec<u8> = samples.iter().flatten().copied().collect();
    let sizes: Vec<usize> = samples.iter().map(Vec::len).collect();
    let content = &content[content.len().saturating_sub(cap)..];
    let mut out = vec![0; cap];
    let params = zstd_sys::ZDICT_params_t {
        compressionLevel: DISPLAY_COMPRESSION_LEVEL,
        notificationLevel: 0,
        dictID: 0,
    };
    // SAFETY: all samples and their sizes remain live, their lengths sum to
    // `all.len()`, and the destination has `cap` writable bytes. The return is
    // classified before it is used as a buffer length.
    let size = unsafe {
        zstd_sys::ZDICT_finalizeDictionary(
            out.as_mut_ptr().cast(),
            cap,
            content.as_ptr().cast(),
            content.len(),
            all.as_ptr().cast(),
            sizes.as_ptr(),
            u32::try_from(sizes.len()).unwrap(),
            params,
        )
    };
    // SAFETY: this classifies the returned integer without reading pointers.
    if unsafe { zstd_sys::ZDICT_isError(size) } != 0 {
        return Vec::new();
    }
    out.truncate(size);
    out
}

fn screen_dictionary(screen: &Screen) -> Vec<u8> {
    let frame = encode(&snapshot(screen));
    finalize_display_dictionary(&frame[BODY..], ROWS, &mut DictionaryScratch::default())
}

fn packed(
    compressor: &mut Compressor,
    entries: &[Entry],
    dictionary: Option<&DisplayDictionary>,
) -> Vec<u8> {
    let raw = encode(entries);
    let mut out = Vec::new();
    if compressor
        .compress_display_frame_into(&raw, dictionary, &mut out)
        .is_some()
    {
        out
    } else {
        raw
    }
}

fn compact_len(frame: &[u8]) -> usize {
    let mut wire = frame.to_vec();
    let start = merkur_codec::wire::write_wire_header_in_place(&mut wire).unwrap();
    wire.len() - start
}

struct Decoder {
    context: zstd::zstd_safe::DCtx<'static>,
    split: Vec<u8>,
    rows: Vec<u8>,
}

impl Decoder {
    fn new(dictionary: Option<&DisplayDictionary>) -> Self {
        use zstd::zstd_safe::{DCtx, DParameter, FrameFormat};
        let mut context = DCtx::create();
        context
            .set_parameter(DParameter::Format(FrameFormat::Magicless))
            .unwrap();
        if let Some(dictionary) = dictionary {
            context.load_dictionary(&dictionary.bytes).unwrap();
        }
        Self {
            context,
            split: Vec::new(),
            rows: Vec::new(),
        }
    }

    fn decode(&mut self, frame: &[u8]) -> Vec<Entry> {
        let count = merkur_codec::parse_frame_header(frame).unwrap().row_count;
        let rows = if frame[DISPLAY_HEADER_FLAGS_OFFSET] & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD != 0
        {
            let offset = if frame[DISPLAY_HEADER_FLAGS_OFFSET]
                & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT
                != 0
            {
                DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET
            } else {
                DISPLAY_COMPRESSED_PAYLOAD_OFFSET
            };
            let length = usize::try_from(u32::from_be_bytes(
                frame[BODY..BODY + 4].try_into().unwrap(),
            ))
            .unwrap();
            self.split.clear();
            self.split
                .reserve(length + merkur_codec::SPLIT_HEADER_MAX_BYTES);
            self.context
                .decompress(&mut self.split, &frame[offset..])
                .unwrap();
            merkur_codec::join_rows_into(&self.split, count, &mut self.rows).unwrap();
            assert_eq!(self.rows.len(), length);
            &self.rows[..]
        } else {
            &frame[BODY..]
        };
        merkur_codec::iter_rows_at(rows, 0, count)
            .map(|row| {
                let row = row.unwrap();
                Entry {
                    row: row.row_index,
                    left: row.left,
                    cells: merkur_codec::cell_iter(row.cells)
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap()
                        .into(),
                }
            })
            .collect()
    }
}

fn assert_entries(actual: &[Entry], expected: &[Entry]) {
    assert_eq!(actual.len(), expected.len());
    for (a, b) in actual.iter().zip(expected) {
        assert_eq!(
            (a.row, a.left, a.cells.as_ref()),
            (b.row, b.left, b.cells.as_ref())
        );
    }
}

/// Reliable install plus its application ACK, each with the existing sealed
/// control framing. Shared QUIC/UDP overhead is excluded and reported as such.
fn install_cost(bytes: usize) -> usize {
    if bytes == 0 {
        0
    } else {
        18 + bytes + 8 + 2 * (4 + crate::e2e::FRAME_OVERHEAD)
    }
}

fn dictionary_trial(updates: &[Update], bytes: Vec<u8>, name: &str, build_us: f64) {
    let dictionary = (!bytes.is_empty()).then(|| DisplayDictionary::new(1, 1, bytes));
    if name != "plain" && dictionary.is_none() {
        eprintln!("DICT_RESULT arm={name} unavailable=true build_us={build_us:.3}");
        return;
    }
    let mut compressor = Compressor::new();
    let mut decoder = Decoder::new(dictionary.as_ref());
    let mut payload = 0;
    let mut raw_payload = 0;
    let mut frames = 0;
    let mut encode_us = 0.0;
    let mut decode_us = 0.0;
    let mut compressed = 0;
    for update in &updates[TRAIN..] {
        for packet in &update.packets {
            let started = Instant::now();
            let frame = packed(&mut compressor, packet, dictionary.as_ref());
            encode_us += started.elapsed().as_secs_f64() * 1e6;
            payload += compact_len(&frame);
            raw_payload += compact_len(&encode(packet));
            frames += 1;
            compressed += usize::from(
                frame[DISPLAY_HEADER_FLAGS_OFFSET] & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD != 0,
            );
            let started = Instant::now();
            let result = decoder.decode(&frame);
            decode_us += started.elapsed().as_secs_f64() * 1e6;
            assert_entries(&result, packet);
        }
    }
    let install = install_cost(dictionary.as_ref().map_or(0, |d| d.bytes.len()));
    eprintln!(
        "DICT_RESULT arm={name} frames={frames} compressed={compressed} raw_bytes={raw_payload} payload_bytes={payload} install_bytes={install} total_bytes={} build_us={build_us:.3} encode_us={encode_us:.3} decode_us={decode_us:.3}",
        payload + install
    );
}

#[test]
#[ignore = "chronological dictionary component comparison"]
fn dictionary_net_profile() {
    let kinds = ["logs", "scroll", "tui", "typing", "entropy", "switch"];
    for kind in kinds {
        let updates = trace(kind);
        let samples = split_samples(&updates[..TRAIN]);
        let mut arms = vec![("plain".to_owned(), Vec::new(), 0.0)];
        let started = Instant::now();
        let bytes = screen_dictionary(&updates[TRAIN - 1].screen);
        arms.push((
            "screen16".to_owned(),
            bytes,
            started.elapsed().as_secs_f64() * 1e6,
        ));
        for cap in [4096, 8192, 16384] {
            let started = Instant::now();
            let bytes = history_dictionary(&samples, cap);
            arms.push((
                format!("history{cap}"),
                bytes,
                started.elapsed().as_secs_f64() * 1e6,
            ));
        }
        let started = Instant::now();
        let screen_samples = split_samples(&[Update {
            screen: updates[TRAIN - 1].screen.clone(),
            hashes: Vec::new(),
            packets: packets(snapshot(&updates[TRAIN - 1].screen)),
        }]);
        let content: Vec<u8> = screen_samples.into_iter().flatten().collect();
        let bytes = finalize_content(&content, &samples, DISPLAY_DICTIONARY_MAX_BYTES);
        arms.push((
            "screen_delta_tables16".to_owned(),
            bytes,
            started.elapsed().as_secs_f64() * 1e6,
        ));
        let started = Instant::now();
        let bytes =
            zstd::dict::from_samples(&samples, DISPLAY_DICTIONARY_MAX_BYTES).unwrap_or_default();
        arms.push((
            "trained16".to_owned(),
            bytes,
            started.elapsed().as_secs_f64() * 1e6,
        ));
        // The generic dictionary uses the other named training traces. Shared
        // generators limit corpus independence; no evaluation samples train it.
        // Its bytes are charged once, including on a modeled cold app load.
        let corpus: Vec<Vec<u8>> = kinds
            .into_iter()
            .filter(|other| *other != kind)
            .flat_map(|other| split_samples(&trace(other)[..TRAIN]))
            .collect();
        let started = Instant::now();
        let bytes = zstd::dict::from_samples(&corpus, 4096).unwrap_or_default();
        arms.push((
            "generic4096".to_owned(),
            bytes,
            started.elapsed().as_secs_f64() * 1e6,
        ));
        for round in 0..4 {
            eprintln!(
                "DICT_CASE workload={kind} round={round} training_updates={TRAIN} evaluation_updates={} training_samples={} training_bytes={}",
                STEPS - TRAIN,
                samples.len(),
                samples.iter().map(Vec::len).sum::<usize>()
            );
            for offset in 0..arms.len() {
                let index = if round % 2 == 0 {
                    offset
                } else {
                    arms.len() - 1 - offset
                };
                let (name, bytes, build_us) = &arms[index];
                dictionary_trial(&updates, bytes.clone(), name, *build_us);
            }
        }
    }
}

/// One test-only packet: an acknowledged snapshot id and source row indices
/// precede a normal literal frame. The cached cells are immutable; references
/// never read another position of the receiver's mutable grid.
struct ReusePacket {
    bytes: Vec<u8>,
}

impl ReusePacket {
    fn is_literal(&self) -> bool {
        self.bytes.first() != Some(&REUSE_TAG)
    }
}

struct ReuseSource<'a> {
    epoch: usize,
    update: &'a Update,
    index: &'a RowIndex,
}

fn reuse_packet(
    compressor: &mut Compressor,
    entries: &[Entry],
    target: &Update,
    source: ReuseSource<'_>,
    dictionary: Option<&DisplayDictionary>,
) -> (ReusePacket, usize) {
    let cache = &source.update.screen;
    let cache_epoch = source.epoch;
    let index = source.index;
    let target_hashes = &target.hashes;
    let target = &target.screen;
    let baseline = packed(compressor, entries, dictionary);
    let mut literals = Vec::new();
    let mut references = Vec::new();
    // The existing production capture already computes these hashes for the
    // ACK baseline. Index construction and collision resolution are timed;
    // terminal parsing/capture is common to both arms and outside this timer.
    for entry in entries {
        let full = &target[usize::from(entry.row)];
        let source = matching_rows(index, target_hashes[usize::from(entry.row)])
            .find(|&source| cache[source].as_ref() == full.as_ref());
        if let Some(source) = source {
            references.push((entry.row, u16::try_from(source).unwrap()));
        } else {
            literals.push(entry.clone());
        }
    }
    if references.is_empty() {
        return (ReusePacket { bytes: baseline }, 0);
    }
    let literal = packed(compressor, &literals, dictionary);
    let mut bytes = vec![REUSE_TAG];
    bytes.extend_from_slice(&u32::try_from(cache_epoch).unwrap().to_be_bytes());
    bytes.extend_from_slice(&u16::try_from(references.len()).unwrap().to_be_bytes());
    for (target, source) in &references {
        bytes.extend_from_slice(&target.to_be_bytes());
        bytes.extend_from_slice(&source.to_be_bytes());
    }
    bytes.extend_from_slice(&literal);
    if compact_len(&literal) + 7 + references.len() * 4 >= compact_len(&baseline) {
        (ReusePacket { bytes: baseline }, 0)
    } else {
        (ReusePacket { bytes }, references.len())
    }
}

fn decode_reuse(
    packet: &ReusePacket,
    cache_epoch: usize,
    cache: &Screen,
    decoder: &mut Decoder,
) -> Result<Vec<Entry>, &'static str> {
    if packet.is_literal() {
        return Ok(decoder.decode(&packet.bytes));
    }
    let epoch_bytes = packet
        .bytes
        .get(1..5)
        .and_then(|bytes| bytes.first_chunk::<4>())
        .ok_or("truncated epoch")?;
    let Ok(epoch) = usize::try_from(u32::from_be_bytes(*epoch_bytes)) else {
        return Err("epoch range");
    };
    if epoch != cache_epoch {
        return Err("snapshot identity");
    }
    let count_bytes = packet
        .bytes
        .get(5..7)
        .and_then(|b| b.first_chunk::<2>())
        .ok_or("truncated count")?;
    let count = usize::from(u16::from_be_bytes(*count_bytes));
    let table_end = 7 + count * 4;
    let table = packet
        .bytes
        .get(7..table_end)
        .ok_or("truncated references")?;
    let mut out = Vec::new();
    for &[a, b, c, d] in table.as_chunks::<4>().0 {
        let row = u16::from_be_bytes([a, b]);
        let source = usize::from(u16::from_be_bytes([c, d]));
        let cells = cache.get(source).ok_or("source outside snapshot")?;
        out.push(Entry {
            row,
            left: 0,
            cells: Arc::clone(cells),
        });
    }
    let literal = packet
        .bytes
        .get(table_end..)
        .filter(|b| b.len() >= BODY)
        .ok_or("truncated literals")?;
    out.extend(decoder.decode(literal));
    Ok(out)
}

fn assert_obligations(actual: &[Entry], expected: &[Entry], target: &Screen) {
    assert_eq!(actual.len(), expected.len());
    for obligation in expected {
        let row = actual.iter().find(|e| e.row == obligation.row).unwrap();
        let start = usize::from(row.left);
        let end = start + row.cells.len();
        assert_eq!(
            row.cells.as_ref(),
            &target[usize::from(row.row)][start..end]
        );
        assert!(row.left <= obligation.left);
        assert!(end >= usize::from(obligation.left) + obligation.cells.len());
    }
}

/// Fixed viewport-sized identity index. Collision resolution still compares
/// complete cells; the index does not allocate one vector per distinct row.
type RowIndex = [(u64, usize); ROWS as usize];

fn row_index(update: &Update) -> RowIndex {
    let mut index = std::array::from_fn(|row| (update.hashes[row], row));
    index.sort_unstable();
    index
}

fn matching_rows(index: &RowIndex, hash: u64) -> impl Iterator<Item = usize> + '_ {
    let start = index.partition_point(|(candidate, _)| *candidate < hash);
    index[start..]
        .iter()
        .take_while(move |(candidate, _)| *candidate == hash)
        .map(|(_, row)| *row)
}

fn moved_content(old: &Update, new: &Update, index: &RowIndex) -> bool {
    new.packets.iter().flatten().any(|entry| {
        let row = usize::from(entry.row);
        matching_rows(index, new.hashes[row])
            .any(|source| source != row && old.screen[source] == new.screen[row])
    })
}

struct ReuseMeasurement {
    bytes: usize,
    references: usize,
    sender_us: f64,
    receiver_us: f64,
    checkpoint_cell_bytes: usize,
}

fn apply_entries(grid: &mut [Vec<CellRepr>], entries: &[Entry]) {
    for entry in entries {
        let left = usize::from(entry.left);
        grid[usize::from(entry.row)][left..left + entry.cells.len()].copy_from_slice(&entry.cells);
    }
}

struct ReuseReceiver {
    decoder: Decoder,
    grid: Vec<Vec<CellRepr>>,
    checkpoints: HashMap<usize, Screen>,
    cpu_us: f64,
    peak_cell_bytes: usize,
}

impl ReuseReceiver {
    fn new(screen: &Screen, dictionary: Option<&DisplayDictionary>) -> Self {
        Self {
            decoder: Decoder::new(dictionary),
            grid: screen.iter().map(|r| r.to_vec()).collect(),
            checkpoints: HashMap::new(),
            cpu_us: 0.0,
            peak_cell_bytes: 0,
        }
    }

    fn apply(
        &mut self,
        packet: &ReusePacket,
        epoch: usize,
        entries: &[Entry],
        target: &Screen,
        duplicate: bool,
    ) {
        let started = Instant::now();
        let empty = Vec::new();
        let owned = self.checkpoints.get(&epoch).unwrap_or(&empty);
        let result = decode_reuse(packet, epoch, owned, &mut self.decoder).unwrap();
        apply_entries(&mut self.grid, &result);
        self.cpu_us += started.elapsed().as_secs_f64() * 1e6;
        assert_obligations(&result, entries, target);
        if duplicate {
            let result = decode_reuse(packet, epoch, owned, &mut self.decoder).unwrap();
            apply_entries(&mut self.grid, &result);
        }
    }

    fn checkpoint(&mut self, step: usize, requested: bool, acknowledged: Option<usize>) {
        let started = Instant::now();
        if let Some(epoch) = acknowledged {
            self.checkpoints.retain(|id, _| *id >= epoch);
        }
        if requested {
            self.checkpoints.insert(
                step,
                self.grid
                    .iter()
                    .map(|row| Arc::from(row.as_slice()))
                    .collect(),
            );
        }
        self.peak_cell_bytes = self.peak_cell_bytes.max(
            self.checkpoints.len()
                * usize::from(ROWS)
                * usize::from(COLS)
                * std::mem::size_of::<CellRepr>(),
        );
        self.cpu_us += started.elapsed().as_secs_f64() * 1e6;
    }
}

fn reuse_wire_len(packet: &ReusePacket) -> usize {
    if packet.is_literal() {
        return compact_len(&packet.bytes);
    }
    let count = usize::from(u16::from_be_bytes(packet.bytes[5..7].try_into().unwrap()));
    7 + count * 4 + compact_len(&packet.bytes[7 + count * 4..])
}

fn reuse_trial(updates: &[Update], lag: usize, reuse: bool, timing: bool) -> ReuseMeasurement {
    let dictionary = screen_dictionary(&updates[TRAIN - 1].screen);
    let dictionary = (!dictionary.is_empty()).then(|| DisplayDictionary::new(1, 1, dictionary));
    reuse_trial_with_dictionary(updates, lag, reuse, timing, dictionary.as_ref())
}

fn reuse_trial_with_dictionary(
    updates: &[Update],
    lag: usize,
    reuse: bool,
    timing: bool,
    dictionary: Option<&DisplayDictionary>,
) -> ReuseMeasurement {
    let mut compressor = Compressor::new();
    let mut receiver = ReuseReceiver::new(&updates[TRAIN - 1].screen, dictionary);
    let mut bytes = install_cost(dictionary.map_or(0, |d| d.bytes.len()));
    let mut hits = 0;
    let mut cpu_us = 0.0;
    let mut pending = VecDeque::new();
    let mut acknowledged = None;
    for step in TRAIN..updates.len() {
        let started = Instant::now();
        while pending.front().is_some_and(|(at, _)| *at <= step) {
            acknowledged = Some(pending.pop_front().unwrap().1);
        }
        let mut requested = false;
        // Ask for an immutable checkpoint only after exact cross-position
        // reuse was observed. A checkpoint cannot be referenced before its
        // modeled application ACK; no timer/streak guesses content similarity.
        if reuse
            && pending.is_empty()
            && moved_content(
                &updates[step - 1],
                &updates[step],
                &row_index(&updates[step - 1]),
            )
        {
            requested = true;
            pending.push_back((step + lag + 1, step));
            bytes += 2 * (12 + 4 + crate::e2e::FRAME_OVERHEAD);
        }
        let cache = acknowledged.map(|epoch| &updates[epoch]);
        let index = cache.filter(|_| reuse).map(row_index);
        cpu_us += started.elapsed().as_secs_f64() * 1e6;
        for entries in &updates[step].packets {
            let started = Instant::now();
            let (packet, references) = if let (Some(epoch), Some(cache), Some(index)) =
                (acknowledged, cache, index.as_ref())
            {
                reuse_packet(
                    &mut compressor,
                    entries,
                    &updates[step],
                    ReuseSource {
                        epoch,
                        update: cache,
                        index,
                    },
                    dictionary,
                )
            } else {
                (
                    ReusePacket {
                        bytes: packed(&mut compressor, entries, dictionary),
                    },
                    0,
                )
            };
            cpu_us += started.elapsed().as_secs_f64() * 1e6;
            hits += references;
            bytes += super::super::planner::display_datagram_wire_len(reuse_wire_len(&packet));
            receiver.apply(
                &packet,
                acknowledged.unwrap_or(0),
                entries,
                &updates[step].screen,
                !timing,
            );
        }
        receiver.checkpoint(step, requested, acknowledged);
        assert!(receiver.checkpoints.len() <= 2);
        for (actual, expected) in receiver.grid.iter().zip(&updates[step].screen) {
            assert_eq!(actual.as_slice(), expected.as_ref());
        }
    }
    ReuseMeasurement {
        bytes,
        references: hits,
        sender_us: cpu_us,
        receiver_us: receiver.cpu_us,
        checkpoint_cell_bytes: receiver.peak_cell_bytes,
    }
}

#[test]
fn reuse_preserves_obligations_with_delayed_checkpoint_acks_and_duplicates() {
    for kind in ["logs", "scroll", "tui", "typing", "entropy", "switch"] {
        let updates = trace(kind);
        for lag in [0, 4, 16] {
            let baseline = reuse_trial(&updates, lag, false, false);
            let reuse = reuse_trial(&updates, lag, true, false);
            assert_eq!(baseline.references, 0);
            if kind == "scroll" && lag == 0 {
                assert!(reuse.references > 0);
            }
        }
    }
}

#[test]
#[ignore = "paired immutable-row component comparison"]
fn row_reuse_net_profile() {
    for kind in ["logs", "scroll", "tui", "typing", "entropy", "switch"] {
        let updates = trace(kind);
        for lag in [0, 4, 16] {
            for round in 0..8 {
                for reuse in if round % 2 == 0 {
                    [false, true]
                } else {
                    [true, false]
                } {
                    let ReuseMeasurement {
                        bytes,
                        references,
                        sender_us,
                        receiver_us,
                        checkpoint_cell_bytes,
                    } = reuse_trial(&updates, lag, reuse, true);
                    eprintln!(
                        "REUSE_RESULT workload={kind} lag={lag} round={round} reuse={reuse} bytes={bytes} references={references} sender_us={sender_us:.3} receiver_us={receiver_us:.3} checkpoint_cell_bytes={checkpoint_cell_bytes}"
                    );
                }
            }
        }
    }
}

#[test]
fn reuse_rejects_a_snapshot_owned_by_another_checkpoint() {
    let updates = trace("scroll");
    let mut bytes = vec![REUSE_TAG];
    bytes.extend_from_slice(&17u32.to_be_bytes());
    bytes.extend_from_slice(&1u16.to_be_bytes());
    bytes.extend_from_slice(&3u16.to_be_bytes());
    bytes.extend_from_slice(&2u16.to_be_bytes());
    bytes.extend_from_slice(&encode(&[]));
    let packet = ReusePacket { bytes };
    let mut decoder = Decoder::new(None);
    assert!(decode_reuse(&packet, 18, &updates[17].screen, &mut decoder).is_err());
    let decoded = decode_reuse(&packet, 17, &updates[17].screen, &mut decoder).unwrap();
    assert_eq!(decoded[0].cells, updates[17].screen[2]);
}

#[test]
#[ignore = "paired dictionary and immutable-row interaction comparison"]
fn dictionary_reuse_cross_profile() {
    for kind in ["logs", "scroll", "tui", "typing", "entropy", "switch"] {
        let updates = trace(kind);
        let samples = split_samples(&updates[..TRAIN]);
        for cap in [4096, 16384] {
            let bytes = history_dictionary(&samples, cap);
            if bytes.is_empty() {
                eprintln!("CROSS_UNAVAILABLE workload={kind} dictionary=history{cap}");
                continue;
            }
            let dictionary = DisplayDictionary::new(1, 1, bytes);
            for lag in [0, 16] {
                for round in 0..8 {
                    for reuse in if round % 2 == 0 {
                        [false, true]
                    } else {
                        [true, false]
                    } {
                        let ReuseMeasurement {
                            bytes,
                            references,
                            sender_us,
                            receiver_us,
                            checkpoint_cell_bytes,
                        } = reuse_trial_with_dictionary(
                            &updates,
                            lag,
                            reuse,
                            true,
                            Some(&dictionary),
                        );
                        eprintln!(
                            "CROSS_RESULT workload={kind} dictionary=history{cap} lag={lag} round={round} reuse={reuse} bytes={bytes} references={references} sender_us={sender_us:.3} receiver_us={receiver_us:.3} checkpoint_cell_bytes={checkpoint_cell_bytes}"
                        );
                    }
                }
            }
        }
    }
}
