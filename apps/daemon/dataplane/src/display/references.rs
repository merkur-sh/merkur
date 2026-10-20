//! The daemon's half of MZ row references: which complete rows a peer's
//! history holds as an acknowledged datagram carried them, by content.
//!
//! The browser records every complete row of every delta it decodes, as the
//! frame carried it, whether or not its grid applied the row; so a row that
//! datagram `X` carried whole is a source once `X`'s ACK arrives, whatever was
//! sent to that row after it. A [`MzLedger`] here records every complete row
//! sent, a superset of the browser's under the same retirement, so a source the
//! ledger still holds the browser holds too, and the reference names it by
//! datagram and row alone.

use crate::connection::SentRow;
use crate::display::policy::DisplayPolicy;
use crate::display::recv::display_seq_is_older;
use crate::pty::CapturedRow;
use merkur_codec::CellRepr;
use merkur_codec::mz::{
    MZ_REFERENCE_DATAGRAMS, MzLedger, MzReference, MzStore, full_row_entry_bytes,
};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

struct Source {
    seq: u32,
    row: u16,
    cells: Arc<[CellRepr]>,
}

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

#[derive(Default)]
pub struct ReferenceIndex {
    /// Newest acknowledged source of each row content, by its capture hash.
    by_hash: HashMap<u64, Source>,
    /// `(seq, hash)` in insertion order, so sources retire oldest first.
    order: VecDeque<(u32, u64)>,
    /// Datagrams sent with references whose outcome is not yet known. Each
    /// has a sent-datagram record until its outcome is noted here.
    referencing: VecDeque<u32>,
    /// What the browser's history holds at most.
    ledger: MzLedger,
    /// Every datagram that went out with a reference.
    #[cfg(test)]
    pub(crate) frames_referencing: usize,
}

impl ReferenceIndex {
    /// Trust no source again: the browser may have refused one. The ledger
    /// stays, since what the browser stores does not change with trust.
    pub fn clear(&mut self) {
        self.by_hash.clear();
        self.order.clear();
        self.referencing.clear();
    }

    /// The grid changed geometry, and the browser's history with it.
    pub fn resize(&mut self) {
        self.clear();
        self.ledger.clear();
    }

    /// Datagram `seq` went out carrying `rows`: every one the browser will
    /// record enters the ledger.
    pub fn note_sent<'a>(&mut self, seq: u32, rows: impl IntoIterator<Item = &'a SentRow>) {
        for sent in rows {
            if recorded(sent) {
                self.ledger
                    .record(seq, sent.row, sent.hash, &mut Sizes(&sent.cells));
            }
        }
    }

    /// The browser acknowledged datagram `seq`, which carried `rows`.
    pub fn note_applied<'a>(&mut self, seq: u32, rows: impl IntoIterator<Item = &'a SentRow>) {
        if let Some(position) = self.referencing.iter().position(|&sent| sent == seq) {
            self.referencing.remove(position);
        }
        for sent in rows {
            // A graphics section belongs to its own row and is never written
            // through a reference.
            if !recorded(sent) || sent.graphics.is_some() {
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
        let floor = newest.wrapping_sub(MZ_REFERENCE_DATAGRAMS);
        while let Some(&(seq, hash)) = self.order.front() {
            if !display_seq_is_older(seq, floor) && self.ledger.holds(seq) {
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
    /// `presentation_id`, when an acknowledged row held exactly its cells.
    pub fn find(&self, captured: &CapturedRow, presentation_id: u32) -> Option<MzReference> {
        if captured.graphics.version().is_some() {
            return None;
        }
        let source = self.by_hash.get(&captured.hash)?;
        let seq_delta = presentation_id.wrapping_sub(source.seq);
        if seq_delta == 0
            || seq_delta > MZ_REFERENCE_DATAGRAMS
            || !self.ledger.holds(source.seq)
            || (!Arc::ptr_eq(&source.cells, &captured.cells) && *source.cells != *captured.cells)
        {
            return None;
        }
        Some(MzReference {
            seq_delta,
            source_row: source.row,
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
            complete: true,
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

    /// Datagram `seq` carried `rows` and was acknowledged.
    fn acknowledged(index: &mut ReferenceIndex, seq: u32, rows: &[SentRow]) {
        index.note_sent(seq, rows);
        index.note_applied(seq, rows);
    }

    #[test]
    fn an_acknowledged_complete_row_is_named_by_datagram_and_row() {
        let mut index = ReferenceIndex::default();
        let line = cells("cargo test --release");
        acknowledged(&mut index, 40, &[sent(3, &line)]);
        let reference = index
            .find(&captured(2, &line), 45)
            .expect("the scrolled line is referable");
        assert_eq!(reference.seq_delta, 5);
        assert_eq!(reference.source_row, 3);
        assert_eq!(
            reference.full_row_bytes as usize,
            full_row_entry_bytes(&line)
        );
        // Other content, or a presentation outside the reach, has none.
        assert!(index.find(&captured(2, &cells("other")), 45).is_none());
        assert!(index.find(&captured(2, &line), 40).is_none());
        assert!(
            index
                .find(&captured(2, &line), 41 + MZ_REFERENCE_DATAGRAMS)
                .is_none()
        );
    }

    #[test]
    fn a_row_rewritten_before_its_ack_is_still_a_source() {
        // The browser records the older copy as its datagram carried it even
        // when the newer one arrived first and the grid skipped it.
        let mut index = ReferenceIndex::default();
        let line = cells("scrolled away at once");
        index.note_sent(40, &[sent(1, &line)]);
        index.note_sent(41, &[sent(1, &cells("next line"))]);
        index.note_applied(40, &[sent(1, &line)]);
        assert_eq!(
            index.find(&captured(0, &line), 42).map(|r| r.source_row),
            Some(1)
        );
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
        let linked: Arc<[CellRepr]> = linked.into();
        acknowledged(&mut index, 7, &[span, sent(1, &linked)]);
        assert_eq!(index.len(), 0);
    }

    #[test]
    fn a_source_the_ledger_retired_is_never_named() {
        let mut index = ReferenceIndex::default();
        let line = cells("an old line");
        acknowledged(&mut index, 1, &[sent(0, &line)]);
        index.note_sent(600, &[sent(0, &cells("busy"))]);
        assert!(index.find(&captured(5, &line), 400).is_some());
        // Sending datagram 1100 retires everything before 77 from the
        // browser's window, so datagram 1 is gone there.
        index.note_sent(1100, &[sent(0, &cells("busier"))]);
        assert!(index.find(&captured(5, &line), 400).is_none());
    }

    #[test]
    fn a_referencing_datagram_whose_outcome_never_arrives_retires_every_source() {
        let mut index = ReferenceIndex::default();
        acknowledged(&mut index, 1, &[sent(0, &cells("source"))]);
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
    fn losing_a_frame_that_carried_references_retires_every_source() {
        let mut index = ReferenceIndex::default();
        let line = cells("source");
        acknowledged(&mut index, 10, &[sent(0, &line)]);
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
        let mut index = ReferenceIndex::default();
        acknowledged(&mut index, 1, &[sent(0, &cells("old"))]);
        acknowledged(
            &mut index,
            2 + MZ_REFERENCE_DATAGRAMS,
            &[sent(1, &cells("new"))],
        );
        assert_eq!(index.len(), 1);
    }
}
