import { DISPLAY_COLOR_MODE_INDEXED, DISPLAY_ROW_PREFIX_BYTES } from '../../packages/shared/src';

/**
 * A display row body of `rows` plain text rows, `cols` cells each, as
 * merkur-codec encodes them: the row prefix, the indexed colour mode, then one
 * default-style cell per column (tag 0 and a one-byte codepoint). `next` yields
 * each cell's printable ASCII codepoint. The display fixture refuses anything
 * that is not a row body.
 */
export function createTextRowBody(rows: number, cols: number, next: () => number): Uint8Array {
  const cellBytes = 1 + cols * 2;
  const body = new Uint8Array(rows * (DISPLAY_ROW_PREFIX_BYTES + cellBytes));
  const view = new DataView(body.buffer);
  let offset = 0;
  for (let row = 0; row < rows; row += 1) {
    view.setUint16(offset, row);
    view.setUint16(offset + 4, cols);
    view.setUint16(offset + 6, cellBytes);
    offset += DISPLAY_ROW_PREFIX_BYTES;
    body[offset++] = DISPLAY_COLOR_MODE_INDEXED;
    for (let col = 0; col < cols; col += 1) {
      const codepoint = next();
      if (codepoint < 0x20 || codepoint > 0x7e) {
        throw new RangeError(`text row codepoint ${codepoint} is not printable ASCII`);
      }
      body[offset++] = 0;
      body[offset++] = codepoint;
    }
  }
  return body;
}
