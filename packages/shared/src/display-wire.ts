/**
 * The wire form of a display frame's header, mirrored from `merkur_codec::wire`
 * and pinned to it by `display-wire.test.ts`.
 *
 * In memory a frame is staged: the stream header, the fixed frame header the
 * `DISPLAY_*_OFFSET` constants describe, headroom, then the body. On the wire
 * its header is compact: fixed-offset routing fields, a packed geometry word,
 * any identity block, then varints relative to the frame's own fields and
 * optional fields behind presence bits. A frame is identified by its sequence
 * number unless it carries an identity block, as a snapshot chunk or a
 * zero-seq reliable record does. The browser reads only fixed offsets;
 * term-wasm stages the rest.
 */
import {
  DISPLAY_BASE_SEQ_OFFSET,
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_CHUNK_INDEX_OFFSET,
  DISPLAY_CLOSURE_DIGEST_OFFSET,
  DISPLAY_COLUMNS_OFFSET,
  DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET,
  DISPLAY_DEMAND_SERIAL_OFFSET,
  DISPLAY_ECHO_HORIZON_OFFSET,
  DISPLAY_FRAME_ID_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_GRID_ROWS_OFFSET,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_PRESENTATION_ID_OFFSET,
  DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET,
  DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_COUNT_OFFSET,
  DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SCROLL_SERIAL_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_VERSION_OFFSET,
  MESSAGE_TYPE_DISPLAY_PATCH,
} from './display-stream';
import type { SynchronousByteSource } from './transport-provider';

/** Bytes of the wire header every frame carries at fixed offsets. */
export const DISPLAY_WIRE_FIXED_HEADER_BYTES = 27;
/** An identity block after them: frame id, chunk index and count. */
export const DISPLAY_WIRE_CHUNK_BYTES = 8;
/** The longest wire header of a frame identified by its sequence number. */
export const DISPLAY_WIRE_MAX_UNCHUNKED_HEADER_BYTES = 64;
export const DISPLAY_WIRE_VERSION_OFFSET = 1;
export const DISPLAY_WIRE_FLAGS_OFFSET = 2;
export const DISPLAY_WIRE_PATCH_FLAGS_OFFSET = 3;
export const DISPLAY_WIRE_GENERATION_OFFSET = 4;
export const DISPLAY_WIRE_SEQUENCE_OFFSET = 8;
export const DISPLAY_WIRE_INPUT_SEQUENCE_OFFSET = 12;
/** Stream-flags presence bits, mirroring `merkur_codec::wire::WIRE_PRESENT_*`. */
export const DISPLAY_WIRE_PRESENT_CLOSURE = 1 << 3;
export const DISPLAY_WIRE_PRESENT_ECHO_HORIZON = 1 << 4;
export const DISPLAY_WIRE_PRESENT_CHUNK = 1 << 5;
export const DISPLAY_WIRE_PRESENT_PREDECESSOR = 1 << 6;
/** The compression and FEC bits of the stream-flags byte: zstd, FEC, dictionary and MZ. */
const DISPLAY_WIRE_STREAM_FLAG_BITS = 0b1000_0111;

/** The identity a frame's wire header gives a transport-side observer. */
export interface DisplayWireIdentity {
  readonly generation: number;
  readonly seq: number;
  readonly frameId: number;
  readonly chunkIndex: number;
  readonly chunkCount: number;
}

function zigzag(value: number): number {
  const signed = value | 0;
  return ((signed << 1) ^ (signed >> 31)) >>> 0;
}

/**
 * Read a display patch's identity from its wire header, or null for anything
 * that is not a display patch of this version.
 */
export function readDisplayWireIdentity(source: SynchronousByteSource): DisplayWireIdentity | null {
  if (
    source.byteLength < DISPLAY_WIRE_FIXED_HEADER_BYTES ||
    source.getUint8(0) !== MESSAGE_TYPE_DISPLAY_PATCH ||
    source.getUint8(DISPLAY_WIRE_VERSION_OFFSET) !== DISPLAY_PROTOCOL_VERSION
  ) {
    return null;
  }
  const flags = source.getUint8(DISPLAY_WIRE_FLAGS_OFFSET);
  const generation = source.getUint32BE(DISPLAY_WIRE_GENERATION_OFFSET);
  const seq = source.getUint32BE(DISPLAY_WIRE_SEQUENCE_OFFSET);
  if ((flags & DISPLAY_WIRE_PRESENT_CHUNK) === 0) {
    return { generation, seq, frameId: seq, chunkIndex: 0, chunkCount: 1 };
  }
  const chunk = DISPLAY_WIRE_FIXED_HEADER_BYTES;
  if (source.byteLength < chunk + DISPLAY_WIRE_CHUNK_BYTES) return null;
  return {
    generation,
    seq,
    frameId: source.getUint32BE(chunk),
    chunkIndex: source.getUint16BE(chunk + 4),
    chunkCount: source.getUint16BE(chunk + 6),
  };
}

/**
 * The wire form of a staged display frame: what the daemon seals. For tests
 * and benchmarks that hand frames to the client viewer as the daemon would;
 * the daemon's own encoder is `merkur_codec::wire`.
 */
export function encodeDisplayWireFrame(staged: Uint8Array): Uint8Array {
  const view = new DataView(staged.buffer, staged.byteOffset, staged.byteLength);
  const u16 = (offset: number) => view.getUint16(offset);
  const u32 = (offset: number) => view.getUint32(offset);
  const header: number[] = [];
  const pushU32 = (value: number) =>
    header.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  const pushVarint = (value: number) => {
    let rest = value >>> 0;
    while (rest >= 0x80) {
      header.push((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    header.push(rest);
  };

  const seq = u32(DISPLAY_SEQUENCE_OFFSET);
  const inputSeq = u32(DISPLAY_BASE_SEQ_OFFSET);
  const frameId = u32(DISPLAY_FRAME_ID_OFFSET);
  const presentationId = u32(DISPLAY_PRESENTATION_ID_OFFSET);
  const predecessor = u32(DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET);
  const horizon = u32(DISPLAY_ECHO_HORIZON_OFFSET);
  const chunkIndex = u16(DISPLAY_CHUNK_INDEX_OFFSET);
  const chunkCount = u16(DISPLAY_CHUNK_COUNT_OFFSET);
  const closureHigh = u32(DISPLAY_CLOSURE_DIGEST_OFFSET);
  const closureLow = u32(DISPLAY_CLOSURE_DIGEST_OFFSET + 4);
  const chunked = chunkIndex !== 0 || chunkCount !== 1 || frameId !== seq;
  let presence = 0;
  if (closureHigh !== 0 || closureLow !== 0) presence |= DISPLAY_WIRE_PRESENT_CLOSURE;
  if (horizon !== 0) presence |= DISPLAY_WIRE_PRESENT_ECHO_HORIZON;
  if (chunked) presence |= DISPLAY_WIRE_PRESENT_CHUNK;
  if (predecessor !== 0) presence |= DISPLAY_WIRE_PRESENT_PREDECESSOR;

  header.push(MESSAGE_TYPE_DISPLAY_PATCH, staged[DISPLAY_VERSION_OFFSET] ?? 0);
  header.push(
    ((staged[DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET] ?? 0) & DISPLAY_WIRE_STREAM_FLAG_BITS) |
      presence,
  );
  header.push(staged[DISPLAY_PATCH_FLAGS_OFFSET] ?? 0);
  pushU32(u32(DISPLAY_GENERATION_OFFSET));
  pushU32(seq);
  pushU32(inputSeq);
  // cols:10 rows:9 cursor col:10 cursor row:9 shape:4 visible:1 mode:9, as one
  // 52-bit word in seven bytes; every value is exact in a double.
  const cursor = staged[DISPLAY_COLUMNS_OFFSET + 8] ?? 0;
  let word = u16(DISPLAY_COLUMNS_OFFSET);
  word = word * 2 ** 9 + u16(DISPLAY_GRID_ROWS_OFFSET);
  word = word * 2 ** 10 + u16(DISPLAY_COLUMNS_OFFSET + 4);
  word = word * 2 ** 9 + u16(DISPLAY_COLUMNS_OFFSET + 6);
  word = word * 2 ** 4 + (cursor & 0x0f);
  word = word * 2 + ((cursor >> 4) & 0x01);
  word = word * 2 ** 9 + u16(DISPLAY_COLUMNS_OFFSET + 9);
  for (let shift = 6; shift >= 0; shift -= 1) {
    header.push(Math.floor(word / 2 ** (8 * shift)) % 256);
  }
  pushU32(u32(DISPLAY_SCROLL_SERIAL_OFFSET));
  if (chunked) {
    pushU32(frameId);
    header.push(chunkIndex >>> 8, chunkIndex & 0xff, chunkCount >>> 8, chunkCount & 0xff);
  }
  pushVarint(zigzag(frameId - presentationId));
  pushVarint(u16(DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET));
  pushVarint(u16(DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET));
  if (predecessor !== 0) pushVarint(zigzag(presentationId - predecessor));
  pushVarint(u16(DISPLAY_ROW_COUNT_OFFSET));
  pushVarint(u32(DISPLAY_DEMAND_SERIAL_OFFSET));
  if (horizon !== 0) pushVarint(zigzag(inputSeq - horizon));
  if ((presence & DISPLAY_WIRE_PRESENT_CLOSURE) !== 0) {
    pushU32(closureHigh);
    pushU32(closureLow);
  }

  const body = staged.subarray(DISPLAY_ROWS_OFFSET);
  const wire = new Uint8Array(header.length + body.byteLength);
  wire.set(header);
  wire.set(body, header.length);
  return wire;
}
