use crate::cell::CellRepr;
use xxhash_rust::xxh3::{Xxh3, xxh3_64};

/// Per-cell digest layout: codepoint LE (4) | fg (3) | bg (3) | flags (1).
///
/// The flags byte's bit 5 is [`CellRepr::wrapped`], which is row-scoped and
/// therefore only ever set on a row's final cell. Digesting it is what makes
/// the diff notice a row that starts wrapping without any cell changing —
/// filling a row to its last column and then typing one more character sets
/// `WRAPLINE` on a cell whose content stays exactly as it was.
/// Bit 6 preserves explicit default-background paint: equal RGB does not mean
/// equal coverage for images below cell backgrounds.
///
/// Row hashes cross the wire in display heartbeat digests and are compared
/// between daemon and term-wasm builds. The digested byte stream is a protocol
/// invariant. XXH3 streaming digests depend only on the concatenated bytes, not
/// on update boundaries, so the implementation batches each cell's exact field
/// layout into one update.
pub const CELL_DIGEST_BYTES: usize = 11;
const ROW_HASH_BATCH_CELLS: usize = 32;
const ROW_HASH_BATCH_BYTES: usize = CELL_DIGEST_BYTES * ROW_HASH_BATCH_CELLS;

/// Bit position of [`CellRepr::wrapped`] within a packed cell's flags byte.
///
/// Exposed because the wrap bit is row-scoped: a producer that packs cells as
/// it reads them does not know which cell is last until the row ends, so it
/// patches this bit into the final cell's already-packed flags rather than
/// walking the row a second time to repack it.
pub const CELL_DIGEST_WRAPPED_BIT: u8 = crate::cell::CellAttrs::WRAPPED.bits();

/// Write one cell's canonical digest bytes into `out`, which must be exactly
/// [`CELL_DIGEST_BYTES`] long.
///
/// This is the single definition of the digested layout. [`row_hash`] and every
/// fused producer that packs cells as it materializes them go through it, so
/// the protocol invariant cannot drift between them.
#[inline]
pub fn pack_cell_digest(cell: &CellRepr, out: &mut [u8]) {
    out[0..4].copy_from_slice(&cell.codepoint.to_le_bytes());
    out[4..7].copy_from_slice(&cell.fg);
    out[7..10].copy_from_slice(&cell.bg);
    // `CellAttrs` is laid out as this byte, so the pack is a copy.
    out[10] = cell.attrs.bits();
}

/// XXH3 of a row whose digest bytes the caller already holds contiguously.
///
/// Identical output to [`row_hash`] over the same cells, because XXH3 depends
/// only on the concatenated bytes. It is a separate entry point because the
/// one-shot form reads the caller's buffer directly, where the streaming form
/// copies a 192-byte secret into a fresh hasher and then double-buffers the
/// input through its internal stripe buffer — measured 7-15% of the row hash
/// depending on width.
#[inline]
pub fn row_hash_packed(digest: &[u8]) -> u64 {
    xxh3_64(digest)
}

/// Graphics follow the cell and link digest. 0xffff cannot be a link-run
/// column, so the domain boundary is unambiguous without taxing text-only rows.
pub fn append_graphics_digest(digest: &mut Vec<u8>, graphics: Option<u64>) {
    if let Some(graphics) = graphics {
        digest.extend_from_slice(&[0xff, 0xff]);
        digest.extend_from_slice(&graphics.to_be_bytes());
    }
}

/// XXH3 of an opaque byte run.
///
/// Used for the compression-dictionary digest, where the two sides must agree
/// on raw bytes rather than on decoded cells. Separate from [`row_hash`] so a
/// change to the cell digest layout cannot silently alter it.
#[inline]
pub fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = Xxh3::new();
    hasher.update(bytes);
    hasher.digest()
}

/// Append a row's link runs to its packed cell digest.
///
/// A row's digest is its [`CELL_DIGEST_BYTES`]-per-cell stream followed, for a
/// row that holds any link, by one `offset: u16 LE | len: u16 LE | link: u32
/// LE` record per maximal run of equal non-zero link ids. The cell stream has a
/// fixed width for a given column count, so the suffix is unambiguous, and a row
/// with no link hashes byte-for-byte as it did before links existed — which is
/// what keeps the per-cell digest at 11 bytes instead of taxing every cell of
/// every row for a feature most rows never use.
///
/// Producers call this only for a row they saw a link in; `links` is the row's
/// per-column ids. Both the daemon and term-wasm go through it, so the suffix
/// layout has one owner.
pub fn append_link_digest(digest: &mut Vec<u8>, links: impl IntoIterator<Item = u32>) {
    let mut run: Option<(u16, u16, u32)> = None;
    for (column, link) in links.into_iter().enumerate() {
        let column = column as u16;
        match run {
            Some((_, ref mut len, id)) if id == link => *len += 1,
            _ => {
                if let Some(finished) = run.take() {
                    push_link_run(digest, finished);
                }
                if link != 0 {
                    run = Some((column, 1, link));
                }
            }
        }
    }
    if let Some(finished) = run {
        push_link_run(digest, finished);
    }
}

#[inline]
fn push_link_run(digest: &mut Vec<u8>, (offset, len, link): (u16, u16, u32)) {
    digest.extend_from_slice(&offset.to_le_bytes());
    digest.extend_from_slice(&len.to_le_bytes());
    digest.extend_from_slice(&link.to_le_bytes());
}

#[inline]
pub fn row_hash(cells: &[CellRepr]) -> u64 {
    let mut hasher = Xxh3::new();
    let mut batch = [0u8; ROW_HASH_BATCH_BYTES];
    for cells in cells.chunks(ROW_HASH_BATCH_CELLS) {
        for (cell, encoded) in cells.iter().zip(batch.chunks_exact_mut(CELL_DIGEST_BYTES)) {
            pack_cell_digest(cell, encoded);
        }
        hasher.update(&batch[..cells.len() * CELL_DIGEST_BYTES]);
    }
    if cells.iter().any(|cell| cell.link != 0) {
        let mut suffix = Vec::new();
        append_link_digest(&mut suffix, cells.iter().map(|cell| cell.link));
        hasher.update(&suffix);
    }
    hasher.digest()
}

/// The identity of one complete application frame: what a viewport shows once
/// every row and the cursor match it.
///
/// A synchronized redraw can reach the viewer through a clipped burst, a
/// re-diffed repair under a new presentation and a later continuation, so no
/// set of transport sequences names it. Its content does. The daemon stamps
/// this on every frame of a capture taken exactly at an explicit
/// synchronized-update end; the viewer computes it over its own authoritative
/// grid and applied header, and may publish the held screen only on equality.
/// Row hashes are the existing [`row_hash`] invariant both sides already
/// compare. The cursor shape and visibility are masked to their wire width.
/// Zero is reserved for "no claim", so a computed zero maps to one.
pub fn viewport_closure_digest(
    cols: u16,
    rows: u16,
    cursor_col: u16,
    cursor_row: u16,
    cursor_shape: u8,
    cursor_visible: u8,
    row_hashes: &[u64],
) -> u64 {
    let mut hasher = Xxh3::new();
    let mut head = [0u8; 14];
    head[0..4].copy_from_slice(b"MRKC");
    head[4..6].copy_from_slice(&cols.to_le_bytes());
    head[6..8].copy_from_slice(&rows.to_le_bytes());
    head[8..10].copy_from_slice(&cursor_col.to_le_bytes());
    head[10..12].copy_from_slice(&cursor_row.to_le_bytes());
    head[12] = cursor_shape & 0x0f;
    head[13] = cursor_visible & 0x01;
    hasher.update(&head);
    for hash in row_hashes {
        hasher.update(&hash.to_le_bytes());
    }
    hasher.digest().max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cell::CellAttrs;

    fn mixed_attribute_row() -> Vec<CellRepr> {
        vec![
            CellRepr::BLANK,
            CellRepr {
                codepoint: u32::from('A'),
                fg: [0x12, 0x34, 0x56],
                bg: [0x65, 0x43, 0x21],
                attrs: CellAttrs::WIDE | CellAttrs::ITALIC | CellAttrs::INVERSE,
                link: 0,
            },
            CellRepr {
                codepoint: 0x1F600, // 😀
                fg: [0xff, 0xff, 0xff],
                bg: [0x00, 0x00, 0x00],
                attrs: CellAttrs::BOLD | CellAttrs::UNDERLINE | CellAttrs::WRAPPED,
                link: 0,
            },
        ]
    }

    fn reference_hash(cells: &[CellRepr]) -> u64 {
        let mut hasher = Xxh3::new();
        for cell in cells {
            hasher.update(&cell.codepoint.to_le_bytes());
            hasher.update(&cell.fg);
            hasher.update(&cell.bg);
            let mut flags = 0u8;
            if cell.wide() {
                flags |= 1 << 0;
            }
            if cell.bold() {
                flags |= 1 << 1;
            }
            if cell.italic() {
                flags |= 1 << 2;
            }
            if cell.underline() {
                flags |= 1 << 3;
            }
            if cell.inverse() {
                flags |= 1 << 4;
            }
            if cell.wrapped() {
                flags |= 1 << 5;
            }
            hasher.update(&[flags]);
        }
        hasher.digest()
    }

    /// A direct field-by-field reference implementation locks every batch
    /// boundary to the canonical byte stream consumed by existing peers.
    #[test]
    fn batched_digest_matches_reference_byte_sequence() {
        for len in [0, 1, 31, 32, 33, 63, 64, 65, 119, 120, 121, 512] {
            let cells: Vec<CellRepr> = (0..len)
                .map(|index| CellRepr {
                    codepoint: 0x20 + (index % 0x5f) as u32,
                    fg: [index as u8, (index * 3) as u8, (index * 7) as u8],
                    bg: [(index * 11) as u8, (index * 13) as u8, (index * 17) as u8],
                    attrs: CellAttrs::NONE
                        .with(CellAttrs::WIDE, index % 2 == 0)
                        .with(CellAttrs::BOLD, index % 3 == 0)
                        .with(CellAttrs::ITALIC, index % 5 == 0)
                        .with(CellAttrs::UNDERLINE, index % 7 == 0)
                        .with(CellAttrs::INVERSE, index % 11 == 0)
                        .with(CellAttrs::WRAPPED, index + 1 == len),
                    link: 0,
                })
                .collect();
            assert_eq!(row_hash(&cells), reference_hash(&cells), "len={len}");
        }
    }

    /// The streaming reference and the one-shot packed form must agree at every
    /// width, including across the reference's 32-cell batch boundaries. This is
    /// what lets production pack digest bytes as it reads the grid and hash them
    /// in one shot while `row_hash` stays the independent definition the golden
    /// values below pin.
    #[test]
    fn the_packed_one_shot_hash_matches_the_streaming_reference() {
        for len in [0, 1, 31, 32, 33, 63, 64, 65, 119, 120, 121, 512] {
            let cells: Vec<CellRepr> = (0..len)
                .map(|index| CellRepr {
                    codepoint: 0x20 + (index % 0x5f) as u32,
                    fg: [index as u8, (index * 3) as u8, (index * 7) as u8],
                    bg: [(index * 11) as u8, (index * 13) as u8, (index * 17) as u8],
                    attrs: CellAttrs::NONE
                        .with(CellAttrs::WIDE, index % 2 == 0)
                        .with(CellAttrs::BOLD, index % 3 == 0)
                        .with(CellAttrs::ITALIC, index % 5 == 0)
                        .with(CellAttrs::UNDERLINE, index % 7 == 0)
                        .with(CellAttrs::INVERSE, index % 11 == 0)
                        .with(CellAttrs::WRAPPED, index + 1 == len),
                    link: 0,
                })
                .collect();
            let mut packed = vec![0u8; cells.len() * CELL_DIGEST_BYTES];
            for (cell, slot) in cells.iter().zip(packed.chunks_exact_mut(CELL_DIGEST_BYTES)) {
                pack_cell_digest(cell, slot);
            }
            assert_eq!(row_hash(&cells), row_hash_packed(&packed), "len={len}");
        }
    }

    /// A fused producer clears the wrap bit while packing (it cannot yet know
    /// which cell is last) and ORs it into the final flags byte once the row
    /// ends. That must land on exactly the bit the reference digests.
    #[test]
    fn patching_the_wrap_bit_matches_packing_it_directly() {
        let mut cells = mixed_attribute_row();
        let last = cells.len() - 1;
        cells[last].set_wrapped(true);

        let mut patched = vec![0u8; cells.len() * CELL_DIGEST_BYTES];
        for (cell, slot) in cells
            .iter()
            .zip(patched.chunks_exact_mut(CELL_DIGEST_BYTES))
        {
            let mut unwrapped = *cell;
            unwrapped.set_wrapped(false);
            pack_cell_digest(&unwrapped, slot);
        }
        *patched.last_mut().expect("non-empty row") |= CELL_DIGEST_WRAPPED_BIT;

        assert_eq!(row_hash(&cells), row_hash_packed(&patched));
    }

    /// Golden value locking the wire format. Changing it requires a coordinated
    /// protocol version bump because every peer compares this digest.
    #[test]
    fn golden_wire_hash_is_stable() {
        assert_eq!(row_hash(&[CellRepr::BLANK; 4]), 0x8f2b85d5de9cdd2f);
        assert_eq!(row_hash(&mixed_attribute_row()), 0xcda1489b7468d265);
    }

    /// The wrap bit is the only thing separating these two rows, and the second
    /// value is what the digest produced before `wrapped` existed. Together
    /// they pin that adding it moved exactly one bit of one cell's flags byte
    /// and left the rest of the layout alone.
    #[test]
    fn the_wrap_bit_is_the_only_change_to_the_digest() {
        let mut row = mixed_attribute_row();
        assert!(row.last().is_some_and(|cell| cell.wrapped()));
        assert_eq!(row_hash(&row), 0xcda1489b7468d265);
        row.last_mut().expect("row is not empty").set_wrapped(false);
        assert_eq!(row_hash(&row), 0xb454a6cc5ca02a4e);
    }

    /// Links move the hash only through the suffix: a linked row equals its
    /// unlinked digest followed by one record per run, and changing only a link
    /// id — no glyph — changes the hash.
    #[test]
    fn link_runs_are_a_digest_suffix_and_move_the_hash() {
        let mut row = vec![CellRepr::BLANK; 6];
        for cell in &mut row[1..4] {
            cell.link = 7;
        }
        row[5].link = 9;

        let mut packed = vec![0u8; row.len() * CELL_DIGEST_BYTES];
        for (cell, slot) in row.iter().zip(packed.chunks_exact_mut(CELL_DIGEST_BYTES)) {
            pack_cell_digest(cell, slot);
        }
        let unlinked = packed.clone();
        append_link_digest(&mut packed, row.iter().map(|cell| cell.link));
        assert_eq!(
            &packed[unlinked.len()..],
            &[1, 0, 3, 0, 7, 0, 0, 0, 5, 0, 1, 0, 9, 0, 0, 0]
        );
        assert_eq!(row_hash(&row), row_hash_packed(&packed));
        assert_ne!(row_hash(&row), row_hash_packed(&unlinked));

        let mut relinked = row.clone();
        relinked[5].link = 10;
        assert_ne!(row_hash(&row), row_hash(&relinked));
    }
}
