/**
 * The display-delta frames term-wasm is profiled on and benchmarked against.
 *
 * Its own module, with no WebAssembly import, because `term-wasm-pgo.ts` builds
 * its training set from it before any term-wasm package exists: a clean
 * container (the release image) has no `apps/web/src/term-wasm/pkg` until the
 * profile-guided build it is training produces one.
 */
import {
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_COLUMNS_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_GRID_ROWS_OFFSET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_COUNT_OFFSET,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  DISPLAY_VERSION_OFFSET,
  MAX_DISPLAY_FRAME_BYTES,
  MESSAGE_TYPE_DISPLAY_PATCH,
  writeU32BE,
} from '../packages/shared/src';

const CURSOR_VISIBLE_BLOCK = 0x10;
const BRACKETED_PASTE_MODE = 1 << 7;

/** Exact visible glyph encoded at one populated fixture cell. */
export function ingressFixtureCodepoint(
  row: number,
  col: number,
  phase: number,
  memberOrdinal: number,
): number {
  return 33 + ((row + col + phase * 17 + memberOrdinal * 7) % 60);
}

/**
 * Build one valid uncompressed delta. `rowStart` lets a queued FIFO burst use
 * disjoint row cohorts until the finite grid is exhausted. `memberOrdinal`
 * keeps every owner byte-distinct even when a deeper burst must reuse a row.
 */
export function ingressFixture(
  cols: number,
  rows: number,
  dirtyRows: number,
  phase: number,
  styled: boolean,
  rowStart = 0,
  memberOrdinal = 0,
  stableHeader = false,
): Uint8Array {
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    !Number.isSafeInteger(dirtyRows) ||
    !Number.isSafeInteger(rowStart) ||
    !Number.isSafeInteger(memberOrdinal) ||
    cols <= 0 ||
    rows <= 0 ||
    dirtyRows < 0 ||
    rowStart < 0 ||
    rowStart + dirtyRows > rows ||
    memberOrdinal < 0
  ) {
    throw new RangeError('invalid ingress fixture dimensions');
  }
  const cellBytes = styled ? 8 : 2;
  const rowBytes = 8 + 1 + cols * cellBytes;
  const frame = new Uint8Array(DISPLAY_ROWS_OFFSET + dirtyRows * rowBytes);
  if (frame.length > MAX_DISPLAY_FRAME_BYTES) {
    throw new Error('fixture exceeds one legitimate wire record');
  }
  const view = new DataView(frame.buffer);
  frame[0] = MESSAGE_TYPE_DISPLAY_PATCH;
  view.setUint32(
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    frame.length - DISPLAY_STREAM_HEADER_BYTES,
  );
  writeU32BE(frame, DISPLAY_GENERATION_OFFSET, 1);
  frame[DISPLAY_VERSION_OFFSET] = DISPLAY_PROTOCOL_VERSION;
  view.setUint16(DISPLAY_COLUMNS_OFFSET, cols);
  view.setUint16(DISPLAY_GRID_ROWS_OFFSET, rows);
  view.setUint16(
    DISPLAY_STREAM_HEADER_BYTES + 6,
    (phase * 17 + (stableHeader ? 0 : memberOrdinal)) % cols,
  );
  view.setUint16(
    DISPLAY_STREAM_HEADER_BYTES + 8,
    stableHeader ? 0 : (rowStart + Math.max(0, dirtyRows - 1)) % rows,
  );
  frame[DISPLAY_STREAM_HEADER_BYTES + 10] = CURSOR_VISIBLE_BLOCK;
  view.setUint16(DISPLAY_STREAM_HEADER_BYTES + 11, phase % 2 === 0 ? 0 : BRACKETED_PASTE_MODE);
  view.setUint16(DISPLAY_CHUNK_COUNT_OFFSET, 1);
  view.setUint16(DISPLAY_ROW_COUNT_OFFSET, dirtyRows);
  for (
    let rowOffset = 0, offset = DISPLAY_ROWS_OFFSET;
    rowOffset < dirtyRows;
    rowOffset += 1, offset += rowBytes
  ) {
    const row = rowStart + rowOffset;
    view.setUint16(offset, row);
    view.setUint16(offset + 2, 0);
    view.setUint16(offset + 4, cols);
    view.setUint16(offset + 6, 1 + cols * cellBytes);
    frame[offset + 8] = styled ? 1 : 0;
    for (let col = 0, cell = offset + 9; col < cols; col += 1, cell += cellBytes) {
      frame[cell] = styled ? 3 | ((col & 1) << 3) : 0;
      // Glyph varint precedes optional foreground/background RGB in both modes.
      frame[cell + 1] = ingressFixtureCodepoint(row, col, phase, memberOrdinal);
      if (styled) {
        frame.set(
          [
            32 + ((phase + memberOrdinal) % 192),
            80 + (row % 128),
            180,
            14,
            16 + (memberOrdinal % 64),
            18 + (phase % 64),
          ],
          cell + 2,
        );
      }
    }
  }
  return frame;
}
