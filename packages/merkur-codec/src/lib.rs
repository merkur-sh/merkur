// A latency path: the codec runs for every display frame and waits on nothing.
// `clippy.toml` lists the timer calls this denies.
#![cfg_attr(not(test), deny(clippy::disallowed_methods))]

mod cell;
mod decode;
mod encode;
mod graphics;
mod hash;
mod split;
mod stream;
pub mod theme;
mod validate;
mod varint;

pub use cell::{CellAttrs, CellRepr, CellTag, cell_wraps};
pub use decode::{
    CellIter, CodecErr, LinkSpan, RowIter, RowView, cell_iter, iter_rows, iter_rows_at, link_spans,
    parse_frame_header, parse_frame_header_and_rows_start,
};
pub use encode::{
    CellEncoding, EncodeError, FrameHeader, FrameKind, PreparedRowRef, RowRef, encode_cells,
    encode_frame_into, encode_prepared_frame_into, encoded_cells_size, plan_cell_encoding,
    row_cell_count_field, row_left_field, try_encode_frame_into,
};
pub use graphics::{
    GraphicsEncodeScratch, GraphicsVersion, GraphicsWireError, MAX_GRAPHICS_SECTION_BYTES,
    PreparedGraphics, decode_graphics, encode_graphics,
};
pub use hash::{
    CELL_DIGEST_BYTES, CELL_DIGEST_WRAPPED_BIT, append_graphics_digest, append_link_digest,
    hash_bytes, pack_cell_digest, row_hash, row_hash_packed, viewport_closure_digest,
};
pub use split::{RowSplitter, SPLIT_HEADER_MAX_BYTES, join_rows_into};
pub use stream::{
    DISPLAY_BASE_SEQ_OFFSET, DISPLAY_BODY_LENGTH_OFFSET, DISPLAY_GENERATION_OFFSET,
    DISPLAY_MSG_TYPE_OFFSET, DISPLAY_SEQ_OFFSET, DISPLAY_STREAM_FLAGS_OFFSET, StreamHeader,
    parse_stream_header, write_stream_header,
};
pub use theme::{
    ANSI_PALETTE, CATPPUCCIN_MOCHA, DEFAULT_BACKGROUND, DEFAULT_CURSOR, DEFAULT_DIM_FOREGROUND,
    DEFAULT_FOREGROUND, DIM_PALETTE, INDEXED_COLOR_TABLE, indexed_color_for, named_color,
    resolve_color,
};
pub use validate::{
    DisplayFrameValidationBounds, DisplayFrameValidationError, MAX_TERMINAL_CELLS,
    MAX_TERMINAL_COLUMNS, MAX_TERMINAL_ROWS, ValidatedDisplayRow, validate_display_frame,
    validate_display_frame_header, validate_display_rows,
};
pub use varint::{decode_varint_u32, encode_varint_u32};

pub const STREAM_HEADER_BYTES: usize = 18;
/// Resource bound for one encoded or decompressed display frame. It admits a
/// maximum graphics row atomically while bounding receiver staging independently
/// of compression ratio. Aggregate staging has its own owner-side quota.
pub const MAX_DISPLAY_FRAME_BYTES: usize = 1 << 21;
/// Complete row-chunked snapshot staging, before any chunk changes authority.
pub const MAX_DISPLAY_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;

/// Worst-case native text plus link spans and a separate envelope for every row:
/// tag + Unicode varint + two literal RGB colors = 10 bytes/cell; a link span is
/// another 8. Per-row framing includes both link count and color-mode bytes.
pub fn snapshot_graphics_budget(columns: u16, rows: u16) -> Option<usize> {
    let cells = usize::from(columns).checked_mul(usize::from(rows))?;
    if columns == 0
        || rows == 0
        || usize::from(columns) > MAX_TERMINAL_COLUMNS
        || usize::from(rows) > MAX_TERMINAL_ROWS
        || cells > MAX_TERMINAL_CELLS
    {
        return None;
    }
    let text = cells * (10 + LINK_SPAN_BYTES)
        + usize::from(rows)
            * (STREAM_HEADER_BYTES
                + FRAME_HEADER_BODY_BYTES
                + ROW_PREFIX_BYTES
                + LINK_TABLE_COUNT_BYTES
                + 1);
    MAX_DISPLAY_SNAPSHOT_BYTES.checked_sub(text)
}
/// Display wire version, stamped into every patch body and checked by the
/// browser before it applies one.
///
/// 19 is a HARD CUT from 15, combining browser presentation transactions with
/// deadline-aware representation planning, fused receiver validation, and
/// exact resume-repair completion. Version 16 was independently assigned to
/// the incompatible planner-only 23-byte layout described below; 17 was the
/// interim presentation dialect before the repair control shape was corrected.
///
/// Every display patch now carries a `presentation_id` after `frame_id`, and
/// the patch flags carry independent COHERENT and END advisories. These fields
/// never participate in decoding, application, acknowledgement, loss, or FEC
/// correctness: they let the browser hold already-applied dirty rows for one
/// bounded presentation commit without mistaking transport units for paints.
/// Repeating COHERENT on every member makes loss of any one datagram local to
/// that datagram; END is advisory telemetry and may itself be lost.
///
/// `MSG_TYPE_DISPLAY_REPAIR_END` now carries the exact bounded set of display
/// sequences that admitted repair rows. A largest-sequence watermark could
/// open browser presentation while an interior datagram was still missing.
///
/// The browser now reports a bounded receiver-cost posterior in
/// `MSG_TYPE_DISPLAY_RECEIVER_PROFILE`, and `MSG_TYPE_TRANSPORT_HINT` no longer
/// carries the sender-inapplicable bandwidth and compression-threshold fields.
/// A mixed pair would price different display representations from different
/// inputs even though the display envelope remains byte-identical.
///
/// The same unreleased dialect also makes profiling observation boundaries
/// explicit: `MSG_TYPE_PERF_ENABLE` is now the canonical five-byte
/// `enabled:u8 | observation_epoch:u32` control and every timing batch repeats
/// that epoch. Measurement-only grid convergence uses the fixed eight-byte
/// `MSG_TYPE_PERF_GRID_CONVERGENCE_REQUEST` and the bounded full-row-hash
/// `MSG_TYPE_PERF_GRID_CONVERGENCE_RESPONSE`. Neither convergence message is a
/// display application, acknowledgement, repair, or presentation barrier, but
/// their control shapes must still agree across the version gate.
///
/// 15 was a HARD CUT from 14, for recovered-FEC acknowledgement provenance.
///
/// `MSG_TYPE_DISPLAY_ACK` now carries a second 128-bit bitmap, anchored and
/// ordered exactly like the received bitmap, identifying applied sequences the
/// browser reconstructed through FEC. The daemon needs that distinction to
/// adapt scalar replication from attributable path evidence instead of treating
/// a repaired delivery as an ordinary arrival. The ACK body is therefore 40
/// bytes rather than 24, and an old peer rejects it on length.
///
/// 14 was a HARD CUT from 13, for the selective display acknowledgement.
///
/// `MSG_TYPE_DISPLAY_ACK` carried one cumulative sequence and now carries the
/// browser's newest applied sequence plus a 128-bit received bitmap anchored at
/// it. A peer reading the old shape rejects the body outright on length, which
/// is the harmless direction; a peer WRITING the old shape into a new daemon
/// would be worse than harmless, because a cumulative sequence cannot describe a
/// hole and the daemon would credit rows the browser never received.
///
/// The display envelope itself is byte-identical across this change — a
/// datagram-lane frame simply always carries `chunk_index 0` of `chunk_count 1`
/// now — which is precisely why the version has to move: nothing else in this
/// stream detects a control-message skew.
///
/// 13 was a HARD CUT from 12, and carried two independent shape changes that
/// were developed in parallel and land together.
///
/// The first is the row prefix: `cell_count` is now [`ROW_CELL_COUNT_MASK`]
/// wide, with its top bit carrying [`ROW_FLAG_WRAPPED`], and the row hash
/// digests that bit. A peer without it reads a wrapped row of `n` cells as a
/// row of `n + 32768` — rejected as an invalid range rather than misapplied,
/// but rejected with no explanation — and hashes every row differently
/// besides.
///
/// The second is `MSG_TYPE_DISPLAY_RESUME`, which now carries the client's
/// exact per-row grid hashes instead of a 16-row Merkle tree, and which the
/// daemon answers by NOT repairing the rows it matches. A peer reading the old
/// shape either rejects every resume or, worse, matches the wrong bytes and
/// skips repairing rows the client does not have.
///
/// Each was briefly 12 on its own branch, which is why the merge of the two is
/// 13 rather than 12: a peer built from either branch alone stamps 12, speaks
/// exactly one of these two dialects, and would otherwise clear the version
/// gate on its way to misreading the other. The display envelope is unchanged
/// across both, which is precisely why the version has to move — nothing else
/// in this stream detects a row-prefix or control-message skew.
///
/// 11 was a HARD CUT from 10, when display bodies moved from LZ4 to zstd
/// against a finalized dictionary. The envelope was byte-identical, so a peer
/// still running 10 would have read a well-formed frame and handed its payload
/// to an LZ4 decoder — the one failure this stream cannot detect on its own.
///
/// 16 was independently assigned to an incompatible 23-byte display layout on
/// the parallel `perf-1-4` line. The 27-byte presentation layout therefore
/// reserved 17, exact repair membership advanced its branch dialect to 18,
/// and combining it with the incompatible receiver-profile control shape
/// advanced the sole integrated dialect to 19. Version 20 adds the bounded
/// profiling convergence request/response control shape used to prove the
/// browser and daemon grids match after an observation epoch. No branch
/// artifact can pass another branch's version gate.
///
/// Bump this whenever the display stream OR its control messages change shape.
/// Version 21 adds presentation-only member index/count advisories. Complete
/// received groups can present without spending a refresh in a timer; missing
/// members only disable that early release. Application and ACKs never wait.
/// Version 22 removes mutable-grid row back-references. Every row now carries
/// its own cells, so a newer datagram cannot invalidate a delayed datagram's
/// source or turn a local loss/reordering event into a whole-frame rejection.
/// Version 23 adds a presentation-only row predecessor. It prevents a later
/// cursor/header from exposing an unseen earlier row update; application and
/// selective ACKs remain independent and presentation deadlines never extend.
///
/// Version 24 drops the transport hint's flush interval. The daemon no longer
/// paces a flush from a receiver-supplied interval, so the field is gone from
/// the hint body (profile u8, chunk u16, snapshot u32, receive queue u16,
/// presentation period u16 — 11 bytes) rather than being sent and ignored.
///
/// Version 25 adds OSC 8 hyperlinks. The row prefix's `left` field carries
/// [`ROW_FLAG_LINKS`], a flagged row's bytes open with a link span table, the
/// row hash digests link runs, and `MSG_TYPE_DISPLAY_LINK_TABLE` delivers the
/// URIs those ids name. A version-24 peer reads a linked row's `left` as
/// `left + 32768` and rejects the range.
///
/// Version 26 makes the header's mode word the routing decisions the browser
/// acts on (pointer clicks, drags, hover, wheel, alternate screen, prediction
/// grant) instead of raw xterm modes. Browser input became records the daemon
/// encodes, so the mouse-encoding and bracketed-paste bits lost their reader.
///
/// Version 27 adds three decisions: key releases, bare modifiers and focus
/// changes encode to bytes. Until one does, the browser holds that input in its
/// ring and sends it with the next input rather than on a datagram of its own.
///
/// Version 28 adds Kitty graphics. The display envelope body length widens to
/// u32, because a graphics row can exceed 65535 bytes and must remain one
/// independently applicable replacement. Rows carry complete, row-local graphics
/// replacements, and a memory-only patch flag marks lineages that must never
/// reach a disk cache. Graphics identity and geometry participate in the row
/// digest. Because image validation can hold a synchronized update's drain,
/// when no header may leave, the mode word's routing and input-report bits also
/// travel alone on the control lane as the input-routing word
/// (`MSG_TYPE_INPUT_ROUTING`).
///
/// Version 29 bounds display delivery by presentation. The body header gains a
/// u32 demand serial (the browser grant the daemon consumed for this screen
/// state) and the demand-limited / demand-prompt patch flags, and the display
/// ACK carries the browser's cumulative per-generation grant. The daemon admits
/// a new screen state only against an unconsumed grant, and the browser issues
/// at most one grant per animation frame it is shown.
///
/// Version 30 lets the browser present a screen state the moment nothing newer
/// can join it. The body header gains a u64 closure digest naming the complete
/// application frame a capture taken exactly at a synchronized-update end is
/// (see [`viewport_closure_digest`]), and [`PATCH_FLAG_DEMAND_AWAITS_GRANT`]
/// says no newer screen state leaves the daemon before another grant does.
///
/// Version 31 appends a u32 scroll serial: the whole-screen scrolls the
/// terminal had made when a state was captured. Between two states the
/// difference says how far content moved up, so a viewer can tell a cursor
/// that moved from one that stayed with its line as the screen scrolled. It
/// then appends a u32 echo horizon (see [`FrameHeader::echo_horizon`]): the
/// newest input the captured grid could already show an answer to, which the
/// advertised input watermark (PTY write completion) cannot say.
///
/// Version 32 changes what a compressed payload holds. Its rows travel in the
/// stream-split layout of [`RowSplitter`] rather than the row layout, and
/// the zstd frame is magicless with no frame content size, because the envelope
/// already carries the row-body length and the compressed flag. The envelope is
/// byte-identical, so a version-31 receiver would hand a split payload to its
/// row validator — the one failure this stream cannot detect on its own.
pub const VERSION: u8 = 32;
pub const PATCH_FLAG_RESET: u8 = 1 << 0;
pub const PATCH_FLAG_PRESENTATION_COHERENT: u8 = 1 << 1;
pub const PATCH_FLAG_PRESENTATION_END: u8 = 1 << 2;
/// Sticky receiver privacy policy: this display lineage must remain in memory.
pub const PATCH_FLAG_MEMORY_ONLY: u8 = 1 << 3;
/// The daemon held no unconsumed display grant after admitting this state, so
/// the browser must keep issuing one grant per animation frame until its
/// demand window is full.
pub const PATCH_FLAG_DEMAND_LIMITED: u8 = 1 << 4;
/// The grant this state consumed reached a daemon that was already waiting for
/// it, so grant issue to arrival is a pure delivery-loop sample.
pub const PATCH_FLAG_DEMAND_PROMPT: u8 = 1 << 5;
/// When this frame was sent, the peer's output run was paced (its free window
/// had closed) and the daemon held no unconsumed grant: no newer screen state
/// of this output leaves until a grant the daemon did not hold arrives, or the
/// output falls silent for a presentation period and a new run begins.
/// Grant-exempt work (urgent input feedback, repair, header advice) repeats the
/// newest consumed serial and is never a newer state. A clipped prefix never
/// carries it: its remainder follows without a grant.
pub const PATCH_FLAG_DEMAND_AWAITS_GRANT: u8 = 1 << 7;
pub const FRAME_HEADER_BODY_BYTES: usize = 55;
pub const ROW_PREFIX_BYTES: usize = 8;
/// Width of the row prefix's cell count. The field is `u16` on the wire but
/// a row can hold at most [`MAX_TERMINAL_COLUMNS`] cells, so its top bit is
/// free for [`ROW_FLAG_WRAPPED`] and the count is masked out of it.
pub const ROW_CELL_COUNT_MASK: u16 = 0x7fff;
/// Row prefix bit: the row this entry writes continues onto the next row.
///
/// It rides the spare top bit of `cell_count` rather than a ninth prefix byte
/// or a cell tag bit. A byte per row would be nothing on the wire, but the row
/// prefix is a fixed layout mirrored by the encoder, the decoder, the
/// validator, three TypeScript benchmarks and two test suites; a spare bit in
/// a field already bounded to 512 costs none of that and no bytes either. The
/// cell tag has no bit left, and a row-scoped fact should not be paying per
/// cell in any case.
///
pub const ROW_FLAG_WRAPPED: u16 = 0x8000;
/// Width of the row prefix's `left` column. Like the cell count it is bounded
/// by [`MAX_TERMINAL_COLUMNS`], so its top bit carries [`ROW_FLAG_LINKS`].
pub const ROW_LEFT_MASK: u16 = 0x3fff;
/// The row carries a complete graphics replacement after its text bytes.
/// Without this bit, the complete replacement is empty, never unchanged.
pub const ROW_FLAG_GRAPHICS: u16 = 0x4000;
/// Row prefix bit, on `left`: this entry's row bytes open with a link span
/// table (`count: u16` then `count` × [`LINK_SPAN_BYTES`]) before the color
/// mode byte, and `row_byte_count` covers both.
///
/// A row-scoped table rather than a cell field on the wire for the same reason
/// as the wrap bit: the tag byte is full, and the overwhelming majority of rows
/// carry no link and must not pay for the feature. A span is
/// `offset: u16 | len: u16 | link: u32`, offset relative to the entry's `left`.
pub const ROW_FLAG_LINKS: u16 = 0x8000;
/// Bytes per link span in a row's link table.
pub const LINK_SPAN_BYTES: usize = 8;
/// Bytes of a link table's span count.
pub const LINK_TABLE_COUNT_BYTES: usize = 2;
pub const DISPLAY_HEADER_FLAGS_OFFSET: usize = 1;
pub const DISPLAY_HEADER_BODY_LENGTH_OFFSET: usize = 2;
pub const DISPLAY_VERSION_OFFSET: usize = STREAM_HEADER_BYTES;
/// Frame-body offsets. These were private to the daemon encoder, which made
/// them a third copy of a layout `merkur-codec` already owned; the browser
/// mirrors them again in TypeScript. One owner, pinned by
/// `packages/shared/src/display-stream.test.ts`.
pub const DISPLAY_FRAME_ID_OFFSET: usize = STREAM_HEADER_BYTES + 13;
pub const DISPLAY_PRESENTATION_ID_OFFSET: usize = STREAM_HEADER_BYTES + 17;
pub const DISPLAY_CHUNK_INDEX_OFFSET: usize = STREAM_HEADER_BYTES + 21;
pub const DISPLAY_CHUNK_COUNT_OFFSET: usize = STREAM_HEADER_BYTES + 23;
pub const DISPLAY_ROW_COUNT_OFFSET: usize = STREAM_HEADER_BYTES + 25;
pub const DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET: usize = STREAM_HEADER_BYTES + 27;
pub const DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET: usize = STREAM_HEADER_BYTES + 29;
pub const DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET: usize = STREAM_HEADER_BYTES + 31;
/// The browser display grant a state consumed (see [`PATCH_FLAG_DEMAND_LIMITED`]).
pub const DISPLAY_DEMAND_SERIAL_OFFSET: usize = STREAM_HEADER_BYTES + 35;
/// The complete-screen claim this frame's capture makes (see
/// [`viewport_closure_digest`]); zero makes none.
pub const DISPLAY_CLOSURE_DIGEST_OFFSET: usize = STREAM_HEADER_BYTES + 39;
/// The whole-screen scrolls made before this frame's capture (see
/// [`FrameHeader::scroll_serial`]).
pub const DISPLAY_SCROLL_SERIAL_OFFSET: usize = STREAM_HEADER_BYTES + 47;
/// The newest input this frame's capture could show an answer to (see
/// [`FrameHeader::echo_horizon`]).
pub const DISPLAY_ECHO_HORIZON_OFFSET: usize = STREAM_HEADER_BYTES + 51;
pub const DISPLAY_PATCH_FLAGS_OFFSET: usize = STREAM_HEADER_BYTES + 1;
/// Compressed frames preserve the complete display header so routing,
/// assembly, and admission never need to decompress. The u32 at this offset
/// is the decompressed row-payload length.
pub const DISPLAY_COMPRESSED_LENGTH_OFFSET: usize = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
pub const DISPLAY_COMPRESSED_PAYLOAD_OFFSET: usize = DISPLAY_COMPRESSED_LENGTH_OFFSET + 4;
/// Payload offset for a frame compressed against an external dictionary. The
/// envelope extends the plain one with `dict_id: u32` then `dict_hash: u32`.
pub const DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET: usize = DISPLAY_COMPRESSED_LENGTH_OFFSET + 12;
pub const DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD: u8 = 1 << 0;
pub const DISPLAY_HEADER_FLAG_FEC_PROTECTED: u8 = 1 << 1;
/// Set *in addition to* `COMPRESSED_ZSTD` when the body was compressed against
/// an external dictionary. The daemon only sets it for a peer that announced
/// support and acknowledged the exact dictionary.
pub const DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT: u8 = 1 << 2;
pub const DISPLAY_FEC_HEADER_BYTES: usize = 16;
pub const MSG_TYPE_DISPLAY_PATCH: u8 = 0x20;
pub const MSG_TYPE_DISPLAY_FEC_REPAIR: u8 = 0x21;

#[cfg(test)]
mod tests;
