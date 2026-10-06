export const DISPLAY_STREAM_HEADER_BYTES = 18;
/** Per-frame encoded/decompressed staging resource ceiling, mirrored in merkur-codec. */
export const MAX_DISPLAY_FRAME_BYTES = 2 * 1024 * 1024;
export const DISPLAY_MESSAGE_TYPE_OFFSET = 0;
export const DISPLAY_SEQUENCE_OFFSET = 6;
export const DISPLAY_GENERATION_OFFSET = 10;
export const DISPLAY_BASE_SEQ_OFFSET = 14;
export const DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET = 1;
export const DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET = 2;
export const DISPLAY_VERSION_OFFSET = DISPLAY_STREAM_HEADER_BYTES;
export const DISPLAY_PATCH_FLAGS_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 1;
export const DISPLAY_COLUMNS_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 2;
export const DISPLAY_GRID_ROWS_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 4;
export const DISPLAY_PATCH_BODY_HEADER_BYTES = 55;
export const DISPLAY_FRAME_ID_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 13;
export const DISPLAY_PRESENTATION_ID_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 17;
export const DISPLAY_CHUNK_INDEX_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 21;
export const DISPLAY_CHUNK_COUNT_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 23;
export const DISPLAY_ROW_COUNT_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 25;
/** Presentation timing only: these are not reliable-lane chunk fields. */
export const DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 27;
export const DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 29;
/** Presentation-only dependency on the latest carrier-admitted row presentation. */
export const DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 31;
/**
 * Demand serial (u32 big-endian): the browser's cumulative per-generation
 * display grant the daemon consumed to admit this state.
 */
export const DISPLAY_DEMAND_SERIAL_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 35;
/**
 * Closure digest (u64 big-endian): the complete application frame this
 * frame's capture is, or zero for no claim. The daemon stamps it only on a
 * capture taken exactly at an explicit synchronized-update end; the viewer
 * publishes a claimed screen only once its own grid digests to it.
 */
export const DISPLAY_CLOSURE_DIGEST_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 39;
/**
 * Scroll serial (u32 big-endian, wrapping): the whole-screen scrolls the
 * terminal had made when this state was captured. The difference between two
 * states is how far every row's content moved up; a scroll region is not counted.
 */
export const DISPLAY_SCROLL_SERIAL_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 47;
/**
 * Echo horizon (u32 big-endian, the peer's wire input sequence; zero for none):
 * the newest input the daemon had queued for the PTY before the output this
 * capture last applied. No later input can have been answered in this grid.
 * The stream header's input sequence counts completed writes instead, which a
 * capture between a key's write and its echo already covers.
 */
export const DISPLAY_ECHO_HORIZON_OFFSET = DISPLAY_STREAM_HEADER_BYTES + 51;
export const DISPLAY_ROWS_OFFSET = DISPLAY_STREAM_HEADER_BYTES + DISPLAY_PATCH_BODY_HEADER_BYTES;
export const DISPLAY_ROW_PREFIX_BYTES = 8;
/**
 * Mask over the row prefix's `cell_count` field. The field is 16 bits on the
 * wire, but a row holds at most `MAX_TERMINAL_COLUMNS` cells, so its top bit
 * carries `DISPLAY_ROW_FLAG_WRAPPED` instead and the count is read out from
 * under it.
 */
export const DISPLAY_ROW_CELL_COUNT_MASK = 0x7fff;
/**
 * Row prefix bit: the row this entry writes continues onto the next row.
 *
 * The browser's terminal has no VTE parser, so this is the only thing that can
 * tell it a line wraps — and without it a local resize truncates every wrapped
 * line instead of rewrapping it. It rides a spare bit of a field already
 * bounded to 512 rather than a ninth prefix byte, so the row layout every
 * encoder, decoder, validator and benchmark here mirrors stays put.
 *
 * Mirrors `merkur_codec::ROW_FLAG_WRAPPED`.
 */
export const DISPLAY_ROW_FLAG_WRAPPED = 0x8000;
/**
 * First byte of every literal row payload, selecting how that row's non-default
 * colours are carried: `0` for one-byte palette indices (with `0xff` escaping to
 * a literal 24-bit colour) and `1` for plain three-byte literals.
 *
 * A row with no non-default colours still carries the byte, and always as
 * `INDEXED`. It is unconditional rather than emitted only when a row has
 * colours, so the byte sits at an identical offset in every row and leaves row
 * payloads mutually aligned for the compressor. Mirrors
 * `merkur_codec::encode::COLOR_MODE_*`.
 */
export const DISPLAY_COLOR_MODE_INDEXED = 0;
export const DISPLAY_COLOR_MODE_LITERAL = 1;
export const DISPLAY_PATCH_FLAG_RESET = 1 << 0;
/** This datagram belongs to a redraw that should normally present coherently. */
export const DISPLAY_PATCH_FLAG_PRESENTATION_COHERENT = 1 << 1;
/** Advisory marker for the last datagram the sender currently knows for a redraw. */
export const DISPLAY_PATCH_FLAG_PRESENTATION_END = 1 << 2;
/** This display lineage must remain in memory, including after reconnect. */
export const DISPLAY_PATCH_FLAG_MEMORY_ONLY = 1 << 3;
/**
 * The daemon held no unconsumed display grant after admitting this state, so
 * the browser must keep issuing one grant per animation frame.
 */
export const DISPLAY_PATCH_FLAG_DEMAND_LIMITED = 1 << 4;
/**
 * The grant this state consumed reached a daemon that was already waiting for
 * it, so grant-issue-to-arrival time is a pure delivery-loop sample.
 */
export const DISPLAY_PATCH_FLAG_DEMAND_PROMPT = 1 << 5;
/**
 * When this frame was sent the daemon's output run was paced and it held no
 * unconsumed grant: no newer screen state follows until a grant it did not
 * hold reaches it. Grant-exempt frames repeat the newest consumed serial and
 * are never a newer state; a clipped prefix never carries this.
 */
export const DISPLAY_PATCH_FLAG_DEMAND_AWAITS_GRANT = 1 << 7;
export const DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD = 1 << 0;
export const DISPLAY_HEADER_FLAG_FEC_PROTECTED = 1 << 1;
/**
 * Set in addition to `COMPRESSED_ZSTD` when the body was compressed against an
 * external dictionary. The envelope then carries `dict_id` and `dict_hash`
 * before the payload, which is what selects the receiver's dictionary slot.
 * zstd additionally stamps its own dictionary id inside every frame, so a
 * decoder handed the wrong dictionary rejects the frame rather than producing
 * plausible wrong bytes the way the LZ4 encoding this replaced would have.
 */
export const DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT = 1 << 2;
export const DISPLAY_COMPRESSED_LENGTH_OFFSET = DISPLAY_ROWS_OFFSET;
export const DISPLAY_COMPRESSED_PAYLOAD_OFFSET = DISPLAY_COMPRESSED_LENGTH_OFFSET + 4;
export const DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET = DISPLAY_COMPRESSED_LENGTH_OFFSET + 12;
/// Mirrors `merkur_codec::VERSION`; `display-stream.test.ts` pins them
/// together. 13 is a hard cut from 12, carrying two shape changes at once: the
/// row prefix's `cell_count` gave up its top bit to
/// `DISPLAY_ROW_FLAG_WRAPPED` and the row hash digests that bit, and
/// `MSG_TYPE_DISPLAY_RESUME` now carries exact per-row grid hashes instead of
/// a Merkle tree. Each was briefly 12 alone; 13 is the pair. See the Rust
/// constant. 15 hard-cuts the display ACK to add the FEC-recovered mask used
/// to measure repair-needed datagrams separately from residual loss. The
/// presentation-only grouping layout reserved 17 because the parallel perf-1-4
/// line independently assigned 16 to an incompatible 23-byte header. Version
/// 18 additionally replaced the resume-repair numeric high-water with exact
/// admitted sequence membership on that branch. Version 19 is the sole merged
/// dialect, adding the incompatible receiver-profile and slim transport-hint
/// control shapes. Version 20 adds the bounded measurement-only exact-grid
/// convergence controls. Frame application and ACK semantics remain
/// independently sequenced per datagram. Version 21 adds advisory per-group
/// member index/count: complete received redraws may present early; a missing
/// member never delays application or ACKs, only that timing optimization.
/// Version 22 removes mutable-grid back-references: every row carries its
/// cells independently of arrival order or the contents of any other row.
/// Version 23 adds the presentation-only row-predecessor advisory so a later
/// header/cursor cannot present over an earlier row update that was wholly
/// reordered behind it. Application and selective ACK remain independent.
/// Version 24 drops the transport hint's flush interval: the daemon no longer
/// paces a flush from a receiver-supplied interval, so the field is gone from
/// the hint body rather than sent and ignored.
/// Version 26 makes the header's mode word routing decisions (pointer clicks,
/// drags, hover, wheel, alternate screen, prediction grant) instead of raw
/// xterm modes; see `terminal-mode.ts`.
/// Version 27 adds when releases, bare modifiers and focus changes encode, which
/// decides whether the input ring holds them.
/// Version 28 widens the envelope body length to u32 for atomic graphics rows and
/// adds row-local graphics replacements and memory-only display lineages, and the
/// CTRL input-routing word that carries the mode word's routing bits while image
/// validation holds a synchronized update's drain.
/// Version 29 appends the u32 demand serial to the patch body header and adds the
/// demand-limited/demand-prompt patch flags; the display ACK carries the browser's
/// cumulative per-generation display grant.
/// Version 30 appends the u64 closure digest to the patch body header: a
/// capture taken at an explicit synchronized-update end names the complete
/// screen it is, so the viewer can hold the previous one until its grid matches.
/// Version 31 appends the u32 scroll serial: the whole-screen scrolls made when
/// a state was captured, so a viewer can tell a cursor that moved from one
/// that stayed with its line as the screen scrolled. Then the u32 echo horizon:
/// the newest input the captured grid could already show an answer to.
/// Version 32 carries a compressed frame's rows in the stream-split layout,
/// as a magicless zstd frame without a content size; the envelope is unchanged.
export const DISPLAY_PROTOCOL_VERSION = 32;
export const DISPLAY_FEC_HEADER_BYTES = 16;
export const DISPLAY_FEC_MAX_DATA_SHARDS = 4;
export const DISPLAY_FEC_MAX_RECOVERY_SHARDS = 2;
export const MESSAGE_TYPE_DISPLAY_PATCH = 0x20;
export const MESSAGE_TYPE_DISPLAY_FEC_REPAIR = 0x21;
