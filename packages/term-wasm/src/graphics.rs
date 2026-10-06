//! Received and presentation-eligible graphics have separate immutable owners.
//! Asset availability never participates in admission, authority or row hashes.

use merkur_codec::{FrameHeader, ValidatedDisplayRow};
use merkur_graphics::budget::{Budget, Lease, Usage};
use merkur_graphics::projection::{
    Fragment, ProjectionError, RETAINED_GRAPHICS_BYTES, RowFragments,
};

/// Retained descriptor resource bound, shared by received, eligible and prepared
/// rows. This does not borrow from the independent frame-staging or pixel budget.
const RETAINED_OBJECTS: usize = 3 * 2 * merkur_codec::MAX_TERMINAL_ROWS;

/// Export workspace bound derived from the maximum number of admitted native
/// descriptors, each encoded with a four-byte row index. It cannot borrow memory
/// from received/presented/staged authority while those owners coexist.
const EXPORT_BYTES: usize = RETAINED_GRAPHICS_BYTES / size_of::<Fragment>()
    * (merkur_graphics::projection::FRAGMENT_BYTES + 4);

pub(super) struct GraphicsRows {
    received: Vec<RowFragments>,
    presented: Vec<RowFragments>,
    prepared: Vec<(u16, RowFragments)>,
    budget: Budget,
    revision: u32,
    exported_revision: u32,
    exported: Vec<u8>,
    exported_storage: Option<Lease>,
}

impl GraphicsRows {
    pub(super) fn new() -> Self {
        Self {
            received: Vec::new(),
            presented: Vec::new(),
            prepared: Vec::new(),
            revision: 0,
            exported_revision: 0,
            exported: Vec::new(),
            exported_storage: None,
            budget: Budget::new(Usage {
                bytes: RETAINED_GRAPHICS_BYTES,
                objects: RETAINED_OBJECTS,
            }),
        }
    }

    /// All allocations and semantic checks precede any terminal mutation. On a
    /// failed reservation, even rows prepared earlier in this frame are refunded.
    pub(super) fn prepare(
        &mut self,
        header: FrameHeader,
        rows: &[ValidatedDisplayRow],
        fragments: &[Fragment],
        snapshot: bool,
        seq: u32,
        versions: &[u32],
    ) -> Result<(), ProjectionError> {
        self.prepared.clear();
        for row in rows {
            let index = usize::from(row.row_index);
            if !snapshot
                && !super::display_sequence_is_newer(seq, versions.get(index).copied().unwrap_or(0))
            {
                continue;
            }
            let mut next = self.received.get(index).cloned().unwrap_or_default();
            match next.replace(
                &self.budget,
                header.cols,
                &fragments[row.graphics_start..row.graphics_end],
            ) {
                Ok(false) => {}
                Ok(true) => self.prepared.push((row.row_index, next)),
                Err(error) => {
                    self.prepared.clear();
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    /// Explicit multi-chunk prevalidation retains every row, including rows
    /// equal to current authority. Later chunks must not depend on that mutable
    /// baseline, and every descriptor lease must exist before the first apply.
    pub(super) fn reserve(
        &self,
        header: FrameHeader,
        rows: &[ValidatedDisplayRow],
        fragments: &[Fragment],
    ) -> Result<Vec<(u16, RowFragments)>, ProjectionError> {
        let mut reserved = Vec::with_capacity(rows.len());
        for row in rows {
            let mut next = self
                .received
                .get(usize::from(row.row_index))
                .cloned()
                .unwrap_or_default();
            next.replace(
                &self.budget,
                header.cols,
                &fragments[row.graphics_start..row.graphics_end],
            )?;
            reserved.push((row.row_index, next));
        }
        Ok(reserved)
    }

    pub(super) fn adopt(
        &mut self,
        reserved: &mut Vec<(u16, RowFragments)>,
        snapshot: bool,
        seq: u32,
        versions: &[u32],
    ) {
        self.prepared.clear();
        reserved.retain(|(row, next)| {
            let index = usize::from(*row);
            (snapshot
                || super::display_sequence_is_newer(seq, versions.get(index).copied().unwrap_or(0)))
                && self.received.get(index).is_none_or(|old| !old.same(next))
        });
        std::mem::swap(&mut self.prepared, reserved);
    }

    pub(super) fn apply(&mut self, rows: usize, mut changed: impl FnMut(u16)) {
        self.received.resize_with(rows, RowFragments::default);
        for (row, next) in self.prepared.drain(..) {
            self.received[usize::from(row)] = next;
            changed(row);
        }
    }

    pub(super) fn commit(&mut self, rows: usize, full: bool, dirty: &[u16]) {
        let changed = if full {
            self.presented.len() != self.received.len()
                || self
                    .presented
                    .iter()
                    .zip(&self.received)
                    .any(|(a, b)| !a.same(b))
        } else {
            dirty.iter().any(|&row| {
                let index = usize::from(row);
                self.presented
                    .get(index)
                    .is_none_or(|old| !old.same(&self.received[index]))
            })
        };
        self.presented.resize_with(rows, RowFragments::default);
        if full {
            self.presented.clone_from(&self.received);
        } else {
            for &row in dirty {
                let row = usize::from(row);
                self.presented[row].clone_from(&self.received[row]);
            }
        }
        if changed {
            self.revision = self.revision.wrapping_add(1).max(1);
        }
    }

    pub(super) fn revision(&self) -> u32 {
        self.revision
    }

    /// Export only committed presentation, with no pointer into received rows.
    /// A text-only session retains an empty vector and performs no encoding.
    pub(super) fn export(&mut self) -> &[u8] {
        if self.exported_revision != self.revision {
            let count: usize = self.presented.iter().map(|row| row.as_slice().len()).sum();
            let bytes = count * (merkur_graphics::projection::FRAGMENT_BYTES + 4);
            // Release old backing before refunding its lease or admitting its
            // replacement. Text-only sessions create no export budget/allocation.
            if self.exported.capacity() < bytes || bytes == 0 {
                self.exported = Vec::new();
                self.exported_storage = None;
                if bytes != 0 {
                    self.exported_storage = Some(
                        Budget::new(Usage {
                            bytes: EXPORT_BYTES,
                            objects: 1,
                        })
                        .reserve(Usage { bytes, objects: 1 })
                        .expect("export extent is bounded by admitted row descriptors"),
                    );
                    self.exported.reserve_exact(bytes);
                }
            } else {
                self.exported.clear();
            }
            for (row, fragments) in self.presented.iter().enumerate() {
                for fragment in fragments.as_slice() {
                    self.exported.extend_from_slice(&(row as u32).to_be_bytes());
                    self.exported.extend_from_slice(&fragment.encode());
                }
            }
            self.exported_revision = self.revision;
        }
        &self.exported
    }

    pub(super) fn digest(&self, row: usize) -> Option<u64> {
        self.received.get(row).and_then(RowFragments::digest)
    }

    #[cfg(test)]
    pub(super) fn received(&self, row: usize) -> &[Fragment] {
        self.received.get(row).map_or(&[], RowFragments::as_slice)
    }

    pub(super) fn intersects(&self, row: usize, left: u16, right: u16) -> bool {
        self.received
            .get(row)
            .is_some_and(|row| row.intersects_cells(left, right))
            || self
                .presented
                .get(row)
                .is_some_and(|row| row.intersects_cells(left, right))
    }

    pub(super) fn has_content(&self) -> bool {
        self.received
            .iter()
            .chain(&self.presented)
            .any(|row| !row.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Terminal;
    use alacritty_terminal::grid::Dimensions;
    use merkur_codec::{CellRepr, FrameKind, RowRef};
    use merkur_graphics::geometry::{CELL_UNIT, RowSlice};
    use merkur_graphics::projection::{Content, Stack};

    fn image(left: u16, placement: u64) -> Fragment {
        Fragment {
            content: Content {
                kind: merkur_graphics::projection::ContentKind::Image,
                root: [7; 32],
                width: 16,
                height: 16,
            },
            stack: Stack {
                z: -1,
                image_id: 7,
                placement,
            },
            slice: RowSlice {
                left: u64::from(left) * CELL_UNIT,
                right: u64::from(left + 1) * CELL_UNIT,
                top: 0,
                bottom: CELL_UNIT,
                source_left: 0,
                source_right: 16 * CELL_UNIT,
                source_top: 0,
                source_bottom: 16 * CELL_UNIT,
            },
        }
    }

    fn frame(kind: FrameKind, cols: u16, entries: &[RowRef<'_>]) -> Vec<u8> {
        chunk(kind, cols, entries, 0, 1)
    }

    fn chunk(
        kind: FrameKind,
        cols: u16,
        entries: &[RowRef<'_>],
        chunk_index: u16,
        chunk_count: u16,
    ) -> Vec<u8> {
        let header = FrameHeader {
            memory_only: false,
            kind,
            cols,
            rows: 2,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: 1,
            cursor_visible: 1,
            mode_flags: crate::DISPLAY_MODE_PREDICTION_SAFE as u16,
            frame_id: 1,
            presentation_id: 1,
            chunk_index,
            chunk_count,
            row_count: entries.len() as u16,
            presentation_member_index: 0,
            presentation_member_count: 1,
            row_predecessor_presentation_id: 0,
            presentation_coherent: true,
            presentation_end: true,
            demand_serial: 0,
            demand_limited: false,
            demand_prompt: false,
            demand_awaits_grant: false,
            closure_digest: 0,
            scroll_serial: 0,
            echo_horizon: 0,
        };
        let mut wire = Vec::new();
        merkur_codec::try_encode_frame_into(&mut wire, &header, entries.iter().copied()).unwrap();
        wire[0] = merkur_codec::MSG_TYPE_DISPLAY_PATCH;
        let offset = merkur_codec::DISPLAY_GENERATION_OFFSET;
        wire[offset..offset + 4].copy_from_slice(&1u32.to_be_bytes());
        let offset = merkur_codec::DISPLAY_SEQ_OFFSET;
        wire[offset..offset + 4].copy_from_slice(&(u32::from(chunk_index) + 1).to_be_bytes());
        let length = (wire.len() - merkur_codec::STREAM_HEADER_BYTES) as u32;
        let offset = merkur_codec::DISPLAY_HEADER_BODY_LENGTH_OFFSET;
        wire[offset..offset + 4].copy_from_slice(&length.to_be_bytes());
        wire
    }

    fn patch(graphics: &[Fragment]) -> Vec<u8> {
        frame(
            FrameKind::Delta,
            16,
            &[RowRef {
                row_index: 0,
                left: 0,
                cells: &[CellRepr::BLANK],
                graphics,
            }],
        )
    }

    #[test]
    fn graphics_only_replacement_is_hashed_ordered_and_held_until_commit() {
        let mut terminal = Terminal::new_headless(16, 2);
        terminal.commit_presentation_state();
        assert!(terminal.apply_delta_seq(&patch(&[]), 1));
        let text_hash = terminal.row_hash(0);
        let fragments = [image(0, 1)];
        let image_frame = patch(&fragments);
        assert!(terminal.apply_delta_seq(&image_frame, 2));
        let image_hash = terminal.row_hash(0);
        assert_ne!(image_hash, text_hash);
        assert!(terminal.last_apply_visually_changed());
        let graphics = terminal.graphics.as_ref().unwrap();
        assert_eq!(graphics.received(0), fragments);
        assert!(graphics.presented.is_empty());
        assert_eq!(terminal.graphics_len(), 0);
        assert!(
            terminal
                .graphics
                .as_ref()
                .unwrap()
                .exported_storage
                .is_none()
        );
        assert_eq!(terminal.geometry_state[crate::GEOMETRY_STATE_LEN - 1], 0);
        terminal.commit_presentation_state();
        assert_eq!(terminal.graphics_len(), 124);
        assert_eq!(
            terminal
                .graphics
                .as_ref()
                .unwrap()
                .exported_storage
                .as_ref()
                .unwrap()
                .charge(),
            Usage {
                bytes: 124,
                objects: 1
            }
        );
        assert_eq!(
            terminal.graphics.as_mut().unwrap().export()[4..],
            fragments[0].encode()
        );
        let revision = terminal.geometry_state[crate::GEOMETRY_STATE_LEN - 1];
        assert_ne!(revision, 0);
        assert_eq!(
            terminal.graphics.as_ref().unwrap().presented[0].as_slice(),
            fragments
        );

        assert!(terminal.apply_delta_seq(&patch(&[]), 4));
        assert_eq!(terminal.row_hash(0), text_hash);
        assert_eq!(
            terminal.graphics.as_ref().unwrap().presented[0].as_slice(),
            fragments
        );
        assert!(terminal.apply_delta_seq(&image_frame, 3));
        assert_eq!(terminal.row_hash(0), text_hash);
        assert_eq!(terminal.graphics_len(), 124);
        assert_eq!(
            terminal.geometry_state[crate::GEOMETRY_STATE_LEN - 1],
            revision
        );
        terminal.commit_presentation_state();
        assert!(terminal.graphics.as_ref().unwrap().presented[0].is_empty());
        assert_eq!(terminal.graphics_len(), 0);
        assert!(
            terminal
                .graphics
                .as_ref()
                .unwrap()
                .exported_storage
                .is_none()
        );
        assert_ne!(
            terminal.geometry_state[crate::GEOMETRY_STATE_LEN - 1],
            revision
        );
    }

    #[test]
    fn invalid_late_graphics_and_budget_refusal_leave_all_authority_unchanged() {
        let mut terminal = Terminal::new_headless(16, 2);
        let before = terminal.row_hash(0);
        let fragments = [image(0, 1)];
        let text = CellRepr {
            codepoint: u32::from('X'),
            ..CellRepr::BLANK
        };
        let mut corrupt = frame(
            FrameKind::Delta,
            16,
            &[
                RowRef {
                    row_index: 0,
                    left: 0,
                    cells: &[text],
                    graphics: &[],
                },
                RowRef {
                    row_index: 1,
                    left: 0,
                    cells: &[text],
                    graphics: &fragments,
                },
            ],
        );
        corrupt.pop();
        assert!(!terminal.apply_delta_seq(&corrupt, 1));
        assert_eq!(terminal.row_hash(0), before);
        assert_eq!(terminal.display_row_version(0), 0);
        assert!(terminal.graphics.is_none());

        let mut graphics = GraphicsRows::new();
        graphics.budget = Budget::new(Usage {
            bytes: 0,
            objects: 0,
        });
        terminal.graphics = Some(graphics);
        let refused = frame(
            FrameKind::Snapshot,
            8,
            &[RowRef {
                row_index: 0,
                left: 0,
                cells: &[text],
                graphics: &fragments,
            }],
        );
        assert!(!terminal.apply_state_seq(&refused, 2));
        assert_eq!(terminal.cols(), 16);
        assert_eq!(terminal.row_hash(0), before);
        assert_eq!(terminal.display_row_version(0), 0);
        assert!(terminal.graphics.as_ref().unwrap().prepared.is_empty());
    }

    #[test]
    fn received_and_held_graphics_both_deny_covered_prediction_without_assets() {
        let mut terminal = Terminal::new_headless(16, 2);
        let fragments = [image(0, 1)];
        assert!(terminal.apply_delta_seq(&patch(&fragments), 1));
        terminal.commit_presentation_state();
        assert!(!terminal.speculative_printable_is_safe());
        assert_eq!(terminal.predict_printable(u32::from('x'), 1.0, 1, true), 0);
        assert!(terminal.apply_delta_seq(&patch(&[]), 2));
        assert!(!terminal.speculative_printable_is_safe());
        terminal.commit_presentation_state();
        assert!(terminal.speculative_printable_is_safe());
        assert_ne!(terminal.predict_printable(u32::from('x'), 2.0, 2, true), 0);
        assert!(terminal.apply_delta_seq(&patch(&fragments), 3));
        assert!(!terminal.has_predictions());
    }

    #[test]
    fn a_viewer_owned_resize_keeps_graphics_canonical_until_matching_authority() {
        use merkur_client::{
            input_sequence::InputMapping,
            viewer::{DisplayGrid, Viewer},
        };
        use merkur_wire::protocol::CHANNEL_DISPLAY_COMMIT;
        let mut viewer = Viewer::new(crate::client_grid::ClientGrid::new(16, 2));
        viewer.fence(0.0, merkur_client::session::DisplayFence { lineage: 1 });
        let fragments = [image(6, 1)];
        let original = frame(
            FrameKind::Snapshot,
            16,
            &[RowRef {
                row_index: 0,
                left: 0,
                cells: &[CellRepr::BLANK],
                graphics: &fragments,
            }],
        );
        viewer.receive(
            0.0,
            CHANNEL_DISPLAY_COMMIT,
            &original,
            InputMapping::default(),
        );
        viewer.frame(16.0, 16.0, true, None);
        let hash = viewer.grid_mut().row_hashes()[0];
        let exported = viewer.grid_mut().graphics_fragments().to_vec();
        viewer.resize(8, 2);
        assert_eq!(
            viewer.grid().cols(),
            16,
            "images and text keep their canonical coordinates"
        );
        assert_eq!(viewer.grid_mut().row_hashes()[0], hash);
        assert_eq!(viewer.grid_mut().graphics_fragments(), exported);
        let resized = frame(
            FrameKind::Snapshot,
            8,
            &[RowRef {
                row_index: 0,
                left: 0,
                cells: &[CellRepr::BLANK],
                graphics: &fragments,
            }],
        );
        viewer.receive(
            1.0,
            CHANNEL_DISPLAY_COMMIT,
            &resized,
            InputMapping::default(),
        );
        assert_eq!(viewer.grid().cols(), 8);
        assert_eq!(viewer.grid().terminal().presentation_cols(), 16);
        viewer.frame(32.0, 16.0, true, None);
        assert_eq!(viewer.grid().terminal().presentation_cols(), 8);
        assert_eq!(viewer.grid_mut().graphics_fragments(), exported);
    }

    #[test]
    fn local_resize_preserves_graphics_layout_until_authoritative_snapshot() {
        let mut terminal = Terminal::new_headless(16, 2);
        let fragments = [image(6, 1)];
        assert!(terminal.apply_delta_seq(&patch(&fragments), 1));
        terminal.commit_presentation_state();
        terminal.resize(8, 2);
        assert_eq!(terminal.cols(), 16);
        let resized = frame(
            FrameKind::Snapshot,
            8,
            &[RowRef {
                row_index: 0,
                left: 0,
                cells: &[CellRepr::BLANK],
                graphics: &fragments,
            }],
        );
        assert!(terminal.apply_state_seq(&resized, 2));
        assert_eq!(terminal.cols(), 8);
        assert_eq!(terminal.presentation_grid.columns(), 16);
        terminal.commit_presentation_state();
        assert_eq!(terminal.presentation_grid.columns(), 8);
        assert_eq!(
            terminal.graphics.as_ref().unwrap().presented[0].as_slice(),
            fragments
        );
    }
    #[test]
    fn jumbo_raw_and_compressed_graphics_share_authority_and_reject_missing_privacy() {
        use merkur_codec::*;
        let fragments: Vec<_> = (1..=merkur_graphics::projection::MAX_ROW_FRAGMENTS)
            .map(|placement| image(0, placement as u64))
            .collect();
        let mut raw = patch(&fragments);
        assert!(raw.len() > usize::from(u16::MAX));
        raw[0] = MSG_TYPE_DISPLAY_PATCH;
        raw[DISPLAY_GENERATION_OFFSET..DISPLAY_GENERATION_OFFSET + 4]
            .copy_from_slice(&1u32.to_be_bytes());
        raw[DISPLAY_SEQ_OFFSET..DISPLAY_SEQ_OFFSET + 4].copy_from_slice(&1u32.to_be_bytes());
        let len = (raw.len() - STREAM_HEADER_BYTES) as u32;
        raw[DISPLAY_HEADER_BODY_LENGTH_OFFSET..DISPLAY_HEADER_BODY_LENGTH_OFFSET + 4]
            .copy_from_slice(&len.to_be_bytes());
        let compressed = |raw: &[u8]| {
            use zstd::zstd_safe::{CParameter, FrameFormat};
            let rows_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
            let mut wire = raw[..rows_offset].to_vec();
            wire[DISPLAY_HEADER_FLAGS_OFFSET] = DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD;
            wire.extend_from_slice(&((raw.len() - rows_offset) as u32).to_be_bytes());
            let mut splitter = RowSplitter::default();
            let split = splitter
                .split(
                    &raw[rows_offset..],
                    parse_frame_header(raw).unwrap().row_count,
                )
                .unwrap();
            let mut compressor = zstd::bulk::Compressor::new(3).unwrap();
            compressor
                .set_parameter(CParameter::Format(FrameFormat::Magicless))
                .unwrap();
            compressor
                .set_parameter(CParameter::ContentSizeFlag(false))
                .unwrap();
            wire.extend_from_slice(&compressor.compress(split).unwrap());
            let len = (wire.len() - STREAM_HEADER_BYTES) as u32;
            wire[DISPLAY_HEADER_BODY_LENGTH_OFFSET..DISPLAY_HEADER_BODY_LENGTH_OFFSET + 4]
                .copy_from_slice(&len.to_be_bytes());
            wire
        };
        let zipped = compressed(&raw);
        let mut expected = Terminal::new_headless(16, 2);
        assert!(expected.apply_delta_seq(&raw, 1));
        let expected_hash = expected.row_hash(0);
        for wire in [&raw, &zipped] {
            let mut terminal = Terminal::new_headless(16, 2);
            let handle = terminal.stage_display_frame_bytes(wire);
            assert_ne!(handle, 0, "{:?}", terminal.last_error);
            assert!(terminal.validate_staged_frame(handle));
            assert!(terminal.graphics.as_ref().unwrap().received.is_empty());
            assert!(terminal.apply_staged_delta_seq(handle, 1));
            assert_eq!(terminal.row_hash(0), expected_hash);
            assert_eq!(terminal.graphics.as_ref().unwrap().received(0), fragments);
            terminal.release_staged_frame(handle);
            assert_eq!(terminal.staged_active_wire_bytes, 0);
            assert_eq!(terminal.staged_active_decoded_bytes, 0);
            assert!(
                terminal.staged_validation_pool_graphics_capacity
                    <= 2 * merkur_graphics::projection::MAX_ROW_FRAGMENTS
            );
        }
        raw[STREAM_HEADER_BYTES + 1] &= !PATCH_FLAG_MEMORY_ONLY;
        for wire in [raw.clone(), compressed(&raw)] {
            let mut terminal = Terminal::new_headless(16, 2);
            let before = terminal.row_hash(0);
            let handle = terminal.stage_display_frame_bytes(&wire);
            if handle != 0 {
                assert!(!terminal.validate_staged_frame(handle));
                terminal.release_staged_frame(handle);
            }
            assert!(terminal.graphics.is_none());
            assert_eq!(terminal.row_hash(0), before);
            assert_eq!(terminal.display_row_version(0), 0);
        }
    }

    #[test]
    fn all_chunks_reserve_graphics_before_any_authority_changes() {
        for objects in [2, 4] {
            let mut terminal = Terminal::new_headless(16, 2);
            terminal.commit_presentation_state();
            let before = [terminal.row_hash(0), terminal.row_hash(1)];
            let mut graphics = GraphicsRows::new();
            graphics.budget = Budget::new(Usage {
                bytes: RETAINED_GRAPHICS_BYTES,
                objects,
            });
            let budget = graphics.budget.clone();
            terminal.graphics = Some(graphics);
            let fragments = [image(0, 1)];
            let text = [CellRepr {
                codepoint: u32::from('X'),
                ..CellRepr::BLANK
            }];
            let handles: Vec<_> = (0..2)
                .map(|index| {
                    let wire = chunk(
                        FrameKind::Snapshot,
                        8,
                        &[RowRef {
                            row_index: index,
                            left: 0,
                            cells: &text,
                            graphics: &fragments,
                        }],
                        index,
                        2,
                    );
                    let handle = terminal.stage_display_frame_bytes(&wire);
                    assert_ne!(handle, 0);
                    handle
                })
                .collect();
            assert!(terminal.validate_staged_frame(handles[0]));
            let admitted = budget.used().unwrap();
            assert_eq!(admitted.objects, 2);
            assert!(terminal.validate_staged_frame(handles[0]));
            assert_eq!(budget.used().unwrap(), admitted);
            let accepted = terminal.validate_staged_frame(handles[1]);
            assert_eq!(accepted, objects == 4);
            assert_eq!([terminal.row_hash(0), terminal.row_hash(1)], before);
            assert_eq!(terminal.cols(), 16);
            assert!(terminal.graphics.as_ref().unwrap().received.is_empty());
            if accepted {
                let reserved = budget.used().unwrap();
                for (index, &handle) in handles.iter().enumerate() {
                    assert!(terminal.apply_staged_state_seq(handle, index as u32 + 1));
                    assert_eq!(budget.used().unwrap(), reserved);
                }
                assert_eq!(terminal.cols(), 8);
                assert_eq!(terminal.row_text(0), "X");
                assert_eq!(terminal.row_text(1), "X");
                assert!(terminal.graphics.as_ref().unwrap().presented.is_empty());
                terminal.commit_presentation_state();
                for row in 0..2 {
                    assert_eq!(
                        terminal.graphics.as_ref().unwrap().presented[row].as_slice(),
                        fragments
                    );
                }
            }
            for handle in handles {
                terminal.release_staged_frame(handle);
            }
            if !accepted {
                assert_eq!(
                    budget.used().unwrap(),
                    Usage {
                        bytes: 0,
                        objects: 0
                    }
                );
                assert_eq!([terminal.row_hash(0), terminal.row_hash(1)], before);
            }
        }
    }

    #[test]
    fn staged_graphics_keep_exact_content_and_obey_apply_time_ordering() {
        let mut terminal = Terminal::new_headless(16, 2);
        let initial = [image(0, 1)];
        let replacement = [image(1, 2)];
        assert!(terminal.apply_delta_seq(&patch(&initial), 1));
        let handle = terminal.stage_display_frame_bytes(&patch(&initial));
        assert_ne!(handle, 0);
        assert!(terminal.validate_staged_frame(handle));
        assert!(terminal.apply_delta_seq(&patch(&replacement), 2));
        // Equal at validation time does not mean equal when applied.
        assert!(terminal.apply_staged_delta_seq(handle, 3));
        assert_eq!(terminal.graphics.as_ref().unwrap().received(0), initial);
        terminal.release_staged_frame(handle);

        let handle = terminal.stage_display_frame_bytes(&patch(&replacement));
        assert!(terminal.validate_staged_frame(handle));
        assert!(terminal.apply_delta_seq(&patch(&[]), 5));
        assert!(terminal.apply_staged_delta_seq(handle, 4));
        assert!(terminal.graphics.as_ref().unwrap().received(0).is_empty());
        terminal.release_staged_frame(handle);
    }
}
