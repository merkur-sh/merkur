//! The daemon's half of MZ row references: which acknowledged rows a peer can
//! rebuild from its own history, by content.
//!
//! A row `s` that datagram `X` carried may stand in for another row only when
//! the browser's history rebuilds it as `X` left it. Its ACK proves `X` was
//! applied. What it cannot prove is that `X`'s entry for `s` was not skipped as
//! stale, which happens when a newer send of `s` arrived first, so a source is
//! taken only when no newer send of `s` existed when the ACK arrived: every
//! later send then reaches the browser after `X` did. The reference also
//! carries the rows' hash, and a browser that rebuilds anything else refuses
//! the frame like a lost one.

use crate::connection::SentRow;
use crate::display::policy::DisplayPolicy;
use crate::display::recv::display_seq_is_older;
use crate::pty::CapturedRow;
use merkur_codec::CellRepr;
use merkur_codec::mz::{MzReference, full_row_entry_bytes, mz_reference_datagrams, reference_hash};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

struct Source {
    seq: u32,
    row: u16,
    cells: Arc<[CellRepr]>,
}

#[derive(Default)]
pub struct ReferenceIndex {
    /// Newest acknowledged source of each row content, by its capture hash.
    by_hash: HashMap<u64, Source>,
    /// `(seq, hash)` in insertion order, so sources retire oldest first.
    order: VecDeque<(u32, u64)>,
    /// Datagrams sent with references whose outcome is not yet known. Each
    /// has a sent-datagram record until its outcome is noted here.
    referencing: VecDeque<u32>,
    /// How far back a reference reaches on this grid, as the browser
    /// computes it ([`mz_reference_datagrams`]).
    window: u32,
    /// Every datagram that went out with a reference.
    #[cfg(test)]
    pub(crate) frames_referencing: usize,
}

impl ReferenceIndex {
    /// Forget every source: the browser's history no longer matches them.
    pub fn clear(&mut self) {
        self.by_hash.clear();
        self.order.clear();
        self.referencing.clear();
    }

    /// The grid is now `cols` by `rows`, and its history starts empty.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.clear();
        self.window = mz_reference_datagrams(cols, rows);
    }

    /// The browser applied datagram `seq`, which carried `rows`. `latest_seq`
    /// is each row's newest send at the time of this ACK.
    pub fn note_applied<'a>(
        &mut self,
        seq: u32,
        rows: impl IntoIterator<Item = &'a SentRow>,
        latest_seq: &[u32],
    ) {
        if let Some(position) = self.referencing.iter().position(|&sent| sent == seq) {
            self.referencing.remove(position);
        }
        for sent in rows {
            if sent.graphics.is_some()
                || latest_seq.get(usize::from(sent.row)) != Some(&seq)
                || sent.cells.iter().any(|cell| cell.link != 0)
            {
                continue;
            }
            self.by_hash.insert(
                sent.hash,
                Source {
                    seq,
                    row: sent.row,
                    cells: Arc::clone(&sent.cells),
                },
            );
            self.order.push_back((seq, sent.hash));
        }
        self.retire(seq);
    }

    /// Datagram `seq` was declared lost, or its record ended with its outcome
    /// unknown. If it carried references, a browser may have refused it, so
    /// none of the sources is trusted again.
    pub fn note_unresolved(&mut self, seq: u32) {
        if self.referencing.contains(&seq) {
            self.clear();
        }
    }

    /// Datagram `seq` went out carrying references.
    pub fn note_referencing(&mut self, seq: u32) {
        #[cfg(test)]
        {
            self.frames_referencing += 1;
        }
        // Every entry has a record, so this holds only when a record ended
        // without its outcome reaching here; that outcome is then unknown.
        if self.referencing.len() == DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES {
            self.clear();
        }
        self.referencing.push_back(seq);
    }

    /// Drop sources a frame sent after `newest` could no longer name.
    fn retire(&mut self, newest: u32) {
        let floor = newest.wrapping_sub(self.window);
        while let Some(&(seq, hash)) = self.order.front() {
            if !display_seq_is_older(seq, floor) {
                break;
            }
            self.order.pop_front();
            if self
                .by_hash
                .get(&hash)
                .is_some_and(|source| source.seq == seq)
            {
                self.by_hash.remove(&hash);
            }
        }
    }

    /// A reference for `captured` from a frame of presentation
    /// `presentation_id`, when an acknowledged row holds exactly its cells.
    pub fn find(&self, captured: &CapturedRow, presentation_id: u32) -> Option<MzReference> {
        if captured.graphics.version().is_some() {
            return None;
        }
        let source = self.by_hash.get(&captured.hash)?;
        let seq_delta = presentation_id.wrapping_sub(source.seq);
        if seq_delta == 0
            || seq_delta > self.window
            || (!Arc::ptr_eq(&source.cells, &captured.cells) && *source.cells != *captured.cells)
        {
            return None;
        }
        Some(MzReference {
            seq_delta,
            source_row: source.row,
            hash: reference_hash(&captured.cells),
            full_row_bytes: u32::try_from(full_row_entry_bytes(&captured.cells)).ok()?,
        })
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.by_hash.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_codec::CellAttrs;

    const COLS: u16 = 20;
    const ROWS: u16 = 8;

    fn index() -> ReferenceIndex {
        let mut index = ReferenceIndex::default();
        index.resize(COLS, ROWS);
        index
    }

    fn cells(text: &str) -> Arc<[CellRepr]> {
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
            .collect()
    }

    fn sent(row: u16, cells: &Arc<[CellRepr]>) -> SentRow {
        SentRow {
            row,
            hash: merkur_codec::row_hash(cells),
            cells: Arc::clone(cells),
            graphics: None,
        }
    }

    fn captured(row: u16, cells: &Arc<[CellRepr]>) -> CapturedRow {
        CapturedRow {
            row,
            hash: merkur_codec::row_hash(cells),
            cells: Arc::clone(cells),
            graphics: Default::default(),
        }
    }

    #[test]
    fn an_acknowledged_row_with_no_newer_send_is_named_by_its_content() {
        let mut index = index();
        let line = cells("cargo test --release");
        let mut latest = vec![0u32; 8];
        latest[3] = 40;
        index.note_applied(40, [&sent(3, &line)], &latest);
        let reference = index
            .find(&captured(2, &line), 45)
            .expect("the scrolled line is referable");
        assert_eq!(reference.seq_delta, 5);
        assert_eq!(reference.source_row, 3);
        assert_eq!(reference.hash, reference_hash(&line));
        assert_eq!(
            reference.full_row_bytes as usize,
            full_row_entry_bytes(&line)
        );
        // Other content, or a presentation outside the window, has none.
        assert!(index.find(&captured(2, &cells("other")), 45).is_none());
        assert!(index.find(&captured(2, &line), 40).is_none());
        assert!(
            index
                .find(
                    &captured(2, &line),
                    40 + mz_reference_datagrams(COLS, ROWS) + 1
                )
                .is_none()
        );
    }

    #[test]
    fn a_large_grid_names_only_what_its_browser_history_keeps() {
        let (cols, rows) = (300, 80);
        let window = mz_reference_datagrams(cols, rows);
        assert!(window < merkur_codec::mz::MZ_REFERENCE_DATAGRAMS);
        let mut index = ReferenceIndex::default();
        index.resize(cols, rows);
        let line = cells("tail -f build.log");
        let latest = vec![40u32; 4];
        index.note_applied(40, [&sent(3, &line)], &latest);
        assert!(index.find(&captured(2, &line), 40 + window).is_some());
        assert!(index.find(&captured(2, &line), 40 + window + 1).is_none());
    }

    #[test]
    fn a_referencing_datagram_whose_outcome_never_arrives_retires_every_source() {
        let mut index = index();
        let latest = vec![1u32; 2];
        index.note_applied(1, [&sent(0, &cells("source"))], &latest);
        let mut seqs = 2u32..;
        for seq in seqs.by_ref().take(DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES) {
            index.note_referencing(seq);
        }
        assert_eq!(index.len(), 1);
        // More referencing datagrams than records: one record ended unnoted.
        index.note_referencing(seqs.next().expect("unbounded"));
        assert_eq!(index.len(), 0);
    }

    #[test]
    fn a_row_sent_again_before_its_ack_is_not_a_source() {
        // The newer send may have reached the browser first, which then
        // skipped this entry as stale.
        let mut index = index();
        let line = cells("may have been skipped");
        let mut latest = vec![0u32; 8];
        latest[1] = 41;
        index.note_applied(40, [&sent(1, &line)], &latest);
        assert_eq!(index.len(), 0);
    }

    #[test]
    fn linked_rows_are_never_sources() {
        let mut index = index();
        let mut linked: Vec<CellRepr> = cells("https://example.com").to_vec();
        linked[0].link = 3;
        let linked: Arc<[CellRepr]> = linked.into();
        let latest = vec![7u32; 2];
        index.note_applied(7, [&sent(0, &linked)], &latest);
        assert_eq!(index.len(), 0);
    }

    #[test]
    fn losing_a_frame_that_carried_references_retires_every_source() {
        let mut index = index();
        let line = cells("source");
        let latest = vec![10u32; 4];
        index.note_applied(10, [&sent(0, &line)], &latest);
        index.note_referencing(12);
        // An unrelated loss changes nothing.
        index.note_unresolved(11);
        assert_eq!(index.len(), 1);
        index.note_unresolved(12);
        assert_eq!(index.len(), 0);
        assert!(index.find(&captured(1, &line), 13).is_none());
    }

    #[test]
    fn sources_retire_once_no_frame_can_name_them() {
        let mut index = index();
        let mut latest = vec![0u32; 2];
        latest[0] = 1;
        index.note_applied(1, [&sent(0, &cells("old"))], &latest);
        let newest = 2 + mz_reference_datagrams(COLS, ROWS);
        latest[1] = newest;
        index.note_applied(newest, [&sent(1, &cells("new"))], &latest);
        assert_eq!(index.len(), 1);
    }
}
