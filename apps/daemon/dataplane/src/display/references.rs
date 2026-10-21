//! The owner loop's half of MZ copies: which complete rows a peer's history
//! holds as an acknowledged datagram carried them, and whether the browser may
//! have refused a frame that copied from them.
//!
//! The browser records every complete row of every delta it decodes, as the
//! frame carried it, whether or not its grid applied the row; so a row that
//! datagram `X` carried whole is a source once `X`'s ACK arrives, whatever was
//! sent to that row after it. A [`MzLedger`] here records every complete row
//! sent, a superset of the browser's under the same retirement, so a source the
//! ledger still holds the browser holds too. What this side learns goes to the
//! peer's [`PeerMz`] as facts its encoder applies before the next frame.

use crate::connection::SentRow;
use crate::display::mz_peer::{MzFact, SharedPeerMz, recorded_rows};
#[cfg(test)]
use crate::display::mz_peer::PeerMz;
use crate::display::policy::DisplayPolicy;
use merkur_codec::CellRepr;
use merkur_codec::mz::{MzLedger, MzStore, full_row_entry_bytes};
use std::collections::VecDeque;
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

#[derive(Default)]
pub struct ReferenceIndex {
    /// Datagrams sent with history copies whose outcome is not yet known.
    /// Each has a sent-datagram record until its outcome is noted here.
    referencing: VecDeque<u32>,
    /// What the browser's history holds at most.
    ledger: MzLedger,
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

    /// Trust no source again: the browser may have refused one. The ledger
    /// stays, since what the browser stores does not change with trust.
    pub fn clear(&mut self) {
        self.referencing.clear();
        self.mz.push(MzFact::Untrusted);
    }

    /// The grid changed geometry, and the browser's history and epochs with
    /// it.
    pub fn resize(&mut self) {
        self.referencing.clear();
        self.ledger.clear();
        self.mz.set_floor(None);
        self.mz.push(MzFact::Reset);
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
        self.mz.set_floor(self.ledger.floor());
    }

    /// The browser acknowledged datagram `seq`, which carried `rows`; `coded`
    /// when it was an MZ frame, `declared` the epoch it declared.
    pub fn note_applied<'a>(
        &mut self,
        seq: u32,
        rows: impl IntoIterator<Item = &'a SentRow>,
        coded: bool,
        declared: Option<u8>,
    ) {
        if let Some(position) = self.referencing.iter().position(|&sent| sent == seq) {
            self.referencing.remove(position);
        }
        self.mz.push(MzFact::Applied {
            seq,
            rows: recorded_rows(rows),
            coded,
            declared,
        });
    }

    /// Datagram `seq` was declared lost, or its record ended with its outcome
    /// unknown. If it copied from history, a browser may have refused it, so
    /// none of the sources is trusted again.
    pub fn note_unresolved(&mut self, seq: u32) {
        if self.referencing.contains(&seq) {
            self.clear();
        }
    }

    /// Datagram `seq` went out copying from history.
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

    /// Datagram `seq` carried `rows` and was acknowledged.
    fn acknowledged(index: &mut ReferenceIndex, seq: u32, rows: &[SentRow]) {
        index.note_sent(seq, rows);
        index.note_applied(seq, rows, true, None);
    }

    /// The history candidates a frame of `presentation_id` sees for the first
    /// item pair of `line`.
    fn candidates(index: &ReferenceIndex, line: &Arc<[CellRepr]>, presentation_id: u32) -> Vec<MzCandidate> {
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
        state.history(presentation_id).candidates(pair_hash(item(0), item(1)), &mut out);
        out
    }

    #[test]
    fn an_acknowledged_complete_row_is_found_by_datagram_and_row() {
        let mut index = ReferenceIndex::default();
        let line = cells("cargo test --release");
        acknowledged(&mut index, 40, &[sent(3, &line)]);
        let found = candidates(&index, &line, 45);
        assert_eq!(found.first().map(|c| (c.seq_delta, c.row, c.item)), Some((5, 3, 0)));
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
        let linked: Arc<[CellRepr]> = linked.into();
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

    #[test]
    fn losing_a_frame_that_copied_from_history_retires_every_source() {
        let mut index = ReferenceIndex::default();
        let line = cells("source");
        acknowledged(&mut index, 10, &[sent(0, &line)]);
        index.note_referencing(12);
        // An unrelated loss changes nothing.
        index.note_unresolved(11);
        assert!(!candidates(&index, &line, 13).is_empty());
        index.note_unresolved(12);
        assert!(candidates(&index, &line, 13).is_empty());
    }

    #[test]
    fn a_referencing_datagram_whose_outcome_never_arrives_retires_every_source() {
        let mut index = ReferenceIndex::default();
        let line = cells("source");
        acknowledged(&mut index, 1, &[sent(0, &line)]);
        let mut seqs = 2u32..;
        for seq in seqs.by_ref().take(DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES) {
            index.note_referencing(seq);
        }
        assert!(!candidates(&index, &line, 3).is_empty());
        // More referencing datagrams than records: one record ended unnoted.
        index.note_referencing(seqs.next().expect("unbounded"));
        assert!(candidates(&index, &line, 3).is_empty());
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
