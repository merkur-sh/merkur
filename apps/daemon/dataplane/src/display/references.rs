//! The owner loop's half of MZ copies: which complete rows a peer's history
//! holds as an acknowledged datagram carried them, by display generation.
//!
//! The browser records every complete row of every frame it decodes, as the
//! frame carried it, whether or not its grid applied the row; so a row that
//! datagram `X` carried whole is a source once `X`'s ACK arrives, whatever was
//! sent to that row after it. A snapshot is datagram 0 of its generation, a
//! source once the browser acknowledges anything of that generation. The
//! [`MzGenerations`] here records every complete row sent, a superset of the
//! browser's under the same retirement, so a source the ledger still holds the
//! browser holds too. What this side learns goes to the peer's [`PeerMz`] as
//! facts its encoder applies before the next frame.

use crate::pty::terminal::RowCells;
use crate::connection::SentRow;
use crate::display::mz_peer::{MzFact, SharedPeerMz, recorded_rows};
#[cfg(test)]
use crate::display::mz_peer::PeerMz;
use merkur_codec::CellRepr;
use merkur_codec::mz::{MzGenerations, MzStore, full_row_entry_bytes};
use std::sync::Arc;

/// The ledger's store on this side: the bytes the browser stores for a row,
/// never the row.
struct Sizes<'a>(&'a [CellRepr]);

impl MzStore for Sizes<'_> {
    fn insert(&mut self, _: u64) -> usize {
        full_row_entry_bytes(self.0)
    }

    fn release(&mut self, _: u64) {}
}

/// Whether the browser's history records a row the datagram carried.
fn recorded(sent: &SentRow) -> bool {
    sent.complete && sent.cells.iter().all(|cell| cell.link == 0)
}

/// The complete rows the browser records of one datagram.
type RecordedRows = Vec<(u16, RowCells)>;

#[derive(Default)]
pub struct ReferenceIndex {
    /// What the browser's history holds at most, by generation.
    ledger: MzGenerations,
    /// The current generation's snapshot rows, and whether it was MZ, until
    /// the browser acknowledges anything of the generation: it applies a
    /// generation's deltas only over its snapshot.
    snapshot: Option<(RecordedRows, bool)>,
    /// The browser's count of frames it refused as unresolved, as last read.
    refusals: u32,
    mz: SharedPeerMz,
    /// Every datagram that went out with a history copy.
    #[cfg(test)]
    pub(crate) frames_referencing: usize,
}

impl ReferenceIndex {
    /// The peer's MZ state, which its encoder locks.
    pub(crate) fn shared(&self) -> SharedPeerMz {
        Arc::clone(&self.mz)
    }

    /// Display generation `generation` began: the current generation's rows
    /// stay as the previous one's, the one before retires, and its sequences
    /// start over.
    pub fn begin_generation(&mut self, generation: u32) {
        let previous_floor = self.ledger.floor(self.ledger.current());
        self.ledger.begin(generation, &mut Sizes(&[]));
        self.snapshot = None;
        self.mz.push(MzFact::Generation { generation, previous_floor });
        self.mz.set_floor(None);
    }

    /// The browser discarded every row and epoch, and its count of refusals
    /// started over: its resume claimed no grid.
    pub fn clear(&mut self) {
        self.ledger.clear(&mut Sizes(&[]));
        self.snapshot = None;
        self.refusals = 0;
        self.mz.push(MzFact::Cleared);
        self.mz.set_floor(None);
    }

    /// The browser's ACK reported `refusals`, its running count of frames it
    /// refused as unresolved. A count newer than the last proves this side
    /// named something the browser does not hold; an older one is a
    /// reordered ACK.
    pub fn note_refusals(&mut self, refusals: u32) {
        if matches!(refusals.wrapping_sub(self.refusals), 1..0x8000_0000) {
            self.refusals = refusals;
            self.mz.push(MzFact::Refused);
        }
    }

    /// Datagram `seq` went out carrying `rows`: every one the browser will
    /// record enters the ledger.
    pub fn note_sent<'a>(&mut self, seq: u32, rows: impl IntoIterator<Item = &'a SentRow>) {
        let generation = self.ledger.current();
        for sent in rows {
            if recorded(sent) {
                self.ledger
                    .record(generation, seq, sent.row, sent.hash, &mut Sizes(&sent.cells));
            }
        }
        self.mz.set_floor(self.ledger.floor(generation));
    }

    /// The current generation's snapshot went out as datagram 0, carrying
    /// every row of `grid`, `cols` wide, with `graphics` per row; `coded`
    /// when it was MZ.
    pub fn note_snapshot_sent(
        &mut self,
        grid: &[CellRepr],
        cols: u16,
        graphics: &[Option<merkur_codec::GraphicsVersion>],
        coded: bool,
    ) {
        let generation = self.ledger.current();
        let mut rows = Vec::new();
        for (row, cells) in (0u16..).zip(grid.chunks_exact(usize::from(cols.max(1)))) {
            if cells.iter().any(|cell| cell.link != 0) {
                continue;
            }
            let hash = merkur_codec::row_hash(cells);
            self.ledger.record(generation, 0, row, hash, &mut Sizes(cells));
            // As `recorded_rows`: a row with graphics is never a source.
            if graphics.get(usize::from(row)).is_none_or(Option::is_none) {
                rows.push((row, RowCells::from(cells)));
            }
        }
        self.mz.set_floor(self.ledger.floor(generation));
        self.snapshot = Some((rows, coded));
    }

    /// The browser acknowledged datagram `seq`, which carried `rows`; `coded`
    /// when it was an MZ frame, `declared` the epoch it declared. The first
    /// of a generation also proves its snapshot applied.
    pub fn note_applied<'a>(
        &mut self,
        seq: u32,
        rows: impl IntoIterator<Item = &'a SentRow>,
        coded: bool,
        declared: Option<u8>,
    ) {
        if let Some((rows, coded)) = self.snapshot.take() {
            self.mz.push(MzFact::Applied { seq: 0, rows, coded, declared: None });
        }
        self.mz.push(MzFact::Applied {
            seq,
            rows: recorded_rows(rows),
            coded,
            declared,
        });
    }

    /// Datagram `seq` went out copying from history; the census counts them.
    pub fn note_referencing(&mut self, _seq: u32) {
        #[cfg(test)]
        {
            self.frames_referencing += 1;
        }
    }

    /// The peer's MZ state with every fact applied, for tests.
    #[cfg(test)]
    pub(crate) fn peer(&self) -> &PeerMz {
        &self.mz
    }

    /// Acknowledged rows the peer's frames may copy from, for tests.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.mz.lock().sources()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_codec::mz::{MZ_REFERENCE_DATAGRAMS, MzCandidate, MzMatches};
    use merkur_codec::{CellAttrs, mz::{entry_items, item_hash, pair_hash, encode_full_row_entry}};

    fn cells(text: &str) -> RowCells {
        text.chars()
            .chain(std::iter::repeat(' '))
            .take(20)
            .map(|c| CellRepr {
                codepoint: u32::from(c),
                link: 0,
                fg: merkur_codec::DEFAULT_FOREGROUND,
                bg: merkur_codec::DEFAULT_BACKGROUND,
                attrs: CellAttrs::NONE,
            })
            .collect::<Vec<_>>().into()
    }

    fn sent(row: u16, cells: &RowCells) -> SentRow {
        SentRow {
            row,
            hash: merkur_codec::row_hash(cells),
            cells: RowCells::clone(cells),
            graphics: None,
            complete: true,
        }
    }

    /// Datagram `seq` carried `rows` and was acknowledged.
    fn acknowledged(index: &mut ReferenceIndex, seq: u32, rows: &[SentRow]) {
        index.note_sent(seq, rows);
        index.note_applied(seq, rows, true, None);
    }

    /// The history candidates a frame of `presentation_id` sees for the first
    /// item pair of `line`.
    fn candidates(index: &ReferenceIndex, line: &RowCells, presentation_id: u32) -> Vec<MzCandidate> {
        let mut entry = Vec::new();
        encode_full_row_entry(&mut entry, 0, line);
        let mut items = Vec::new();
        let (first, _) = entry_items(&entry, &mut items).expect("a row");
        let item = |i: usize| {
            let start = if i == 0 { usize::from(first) } else { usize::from(items[i - 1].end) };
            item_hash(&entry[start..usize::from(items[i].end)])
        };
        let state = index.peer().lock();
        let mut out = Vec::new();
        state.history(presentation_id).candidates(pair_hash(item(0), item(1)), |candidate, _| {
            out.push(candidate);
            true
        });
        out
    }

    #[test]
    fn an_acknowledged_complete_row_is_found_by_datagram_and_row() {
        let mut index = ReferenceIndex::default();
        let line = cells("cargo test --release");
        acknowledged(&mut index, 40, &[sent(3, &line)]);
        let found = candidates(&index, &line, 45);
        assert_eq!(found.first().map(|c| (c.previous, c.back, c.row, c.item)), Some((false, 5, 3, 0)));
        // Other content, or a presentation outside the reach, has none.
        assert!(candidates(&index, &cells("other"), 45).is_empty());
        assert!(candidates(&index, &line, 40).is_empty());
        assert!(candidates(&index, &line, 41 + MZ_REFERENCE_DATAGRAMS).is_empty());
    }

    #[test]
    fn a_row_rewritten_before_its_ack_is_still_a_source() {
        // The browser records the older copy as its datagram carried it even
        // when the newer one arrived first and the grid skipped it.
        let mut index = ReferenceIndex::default();
        let line = cells("scrolled away at once");
        index.note_sent(40, &[sent(1, &line)]);
        index.note_sent(41, &[sent(1, &cells("next line"))]);
        index.note_applied(40, &[sent(1, &line)], true, None);
        assert_eq!(candidates(&index, &line, 42).first().map(|c| c.row), Some(1));
    }

    #[test]
    fn spans_linked_rows_and_graphics_rows_are_never_sources() {
        let mut index = ReferenceIndex::default();
        let line = cells("only part of it was sent");
        let span = SentRow {
            complete: false,
            ..sent(0, &line)
        };
        let mut linked: Vec<CellRepr> = cells("https://example.com").to_vec();
        linked[0].link = 3;
        let linked: RowCells = linked.into();
        acknowledged(&mut index, 7, &[span, sent(1, &linked)]);
        assert!(candidates(&index, &line, 9).is_empty());
        assert!(candidates(&index, &linked, 9).is_empty());
    }

    #[test]
    fn a_source_the_ledger_retired_is_never_named() {
        let mut index = ReferenceIndex::default();
        let line = cells("an old line");
        acknowledged(&mut index, 1, &[sent(0, &line)]);
        index.note_sent(600, &[sent(0, &cells("busy"))]);
        assert!(!candidates(&index, &line, 400).is_empty());
        // Sending datagram 1100 retires everything before 77 from the
        // browser's window, so datagram 1 is gone there.
        index.note_sent(1100, &[sent(0, &cells("busier"))]);
        assert!(candidates(&index, &line, 400).is_empty());
    }

    /// The candidates the snapshot opening the next generation sees for the
    /// first item pair of `line`.
    fn snapshot_candidates(index: &ReferenceIndex, line: &RowCells) -> Vec<MzCandidate> {
        let mut entry = Vec::new();
        encode_full_row_entry(&mut entry, 0, line);
        let mut items = Vec::new();
        let (first, _) = entry_items(&entry, &mut items).expect("a row");
        let item = |i: usize| {
            let start = if i == 0 { usize::from(first) } else { usize::from(items[i - 1].end) };
            item_hash(&entry[start..usize::from(items[i].end)])
        };
        let state = index.peer().lock();
        let mut out = Vec::new();
        state.snapshot_history().candidates(pair_hash(item(0), item(1)), |candidate, _| {
            out.push(candidate);
            true
        });
        out
    }

    #[test]
    fn only_a_reported_refusal_retires_every_source() {
        let mut index = ReferenceIndex::default();
        let line = cells("source");
        acknowledged(&mut index, 10, &[sent(0, &line)]);
        // A lost frame that copied proves nothing: the browser's ledger holds
        // whatever this one's does.
        index.note_referencing(12);
        assert!(!candidates(&index, &line, 13).is_empty());
        index.note_refusals(0);
        assert!(!candidates(&index, &line, 13).is_empty());
        index.note_refusals(1);
        assert!(candidates(&index, &line, 13).is_empty());
    }

    #[test]
    fn a_generation_names_the_previous_ones_rows_by_sequence() {
        let mut index = ReferenceIndex::default();
        index.begin_generation(1);
        let line = cells("before the resize");
        acknowledged(&mut index, 40, &[sent(3, &line)]);
        // The snapshot opening generation 2 is coded before it begins.
        assert_eq!(
            snapshot_candidates(&index, &line).first().map(|c| (c.previous, c.back, c.row)),
            Some((true, 40, 3))
        );
        index.begin_generation(2);
        assert_eq!(
            candidates(&index, &line, 5).first().map(|c| (c.previous, c.back, c.row)),
            Some((true, 40, 3)),
            "generation 2's frames name it as the previous generation's"
        );
        index.begin_generation(3);
        assert!(candidates(&index, &line, 5).is_empty(), "two generations back retired");
    }

    #[test]
    fn a_snapshot_is_a_source_once_its_generation_is_acknowledged() {
        let mut index = ReferenceIndex::default();
        index.begin_generation(1);
        let line = cells("on the snapshot");
        let blank = cells("");
        let grid: Vec<CellRepr> = line.iter().chain(blank.iter()).copied().collect();
        index.note_snapshot_sent(&grid, 20, &[None, None], true);
        assert!(candidates(&index, &line, 3).is_empty(), "not before the generation is acknowledged");
        acknowledged(&mut index, 2, &[sent(1, &cells("a delta"))]);
        assert_eq!(
            candidates(&index, &line, 3).first().map(|c| (c.previous, c.back, c.row)),
            Some((false, 3, 0)),
            "datagram 0, three back from presentation 3"
        );
    }

    #[test]
    fn sources_retire_once_no_frame_can_name_them() {
        let mut index = ReferenceIndex::default();
        let old = cells("old");
        acknowledged(&mut index, 1, &[sent(0, &old)]);
        acknowledged(&mut index, 2 + MZ_REFERENCE_DATAGRAMS, &[sent(1, &cells("new"))]);
        assert!(candidates(&index, &old, 2 + MZ_REFERENCE_DATAGRAMS).is_empty());
    }
}
