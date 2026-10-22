/**
 * The terminal's cell record: three `u32` words per cell, laid out by
 * `write_row_cells` in `packages/term-wasm/src/lib.rs` (whose `CELL_*`
 * constants a Rust test pins to these). The grid holds one record per cell at
 * `row * cols + col`; the overlay and touch previews use the same records.
 *
 * - word 0: glyph id (1-based into the glyph table, 0 for none) or, with
 *   `CELL_BUILTIN`, a builtin shape in bits 0..20; the column in bits 20..29;
 *   then `CELL_WIDE`, `CELL_UNDERLINE`, `CELL_STRIKEOUT`.
 * - word 1: text colour RGB (red in the low byte) in bits 0..24, then
 *   `CELL_BUILTIN`, `CELL_BACKGROUND`, the glyph alpha class and `CELL_PREEDIT`.
 * - word 2: background RGB in bits 0..24, the row in bits 24..32.
 */
export const CELL_WORDS = 3;
export const CELL_GLYPH_MASK = 0xfffff;
export const CELL_COLUMN_SHIFT = 20;
export const CELL_WIDE = 0x2000_0000;
export const CELL_UNDERLINE = 0x4000_0000;
export const CELL_STRIKEOUT = 0x8000_0000;
export const CELL_BUILTIN = 0x0100_0000;
export const CELL_BACKGROUND = 0x0200_0000;
export const CELL_ALPHA_DIM = 0x0400_0000;
export const CELL_ALPHA_PREDICTION = 0x0800_0000;
export const CELL_PREEDIT = 0x1000_0000;
export const CELL_ROW_SHIFT = 24;
/** Set in a builtin shape for a quadrant or sextant mosaic; clear for an eighths block. */
export const BUILTIN_MOSAIC = 0x1_0000;
/** Words per glyph table entry: atlas x/y, width/height, signed bearings. */
export const GLYPH_TABLE_WORDS = 3;

/** Pack an `0xRRGGBB` colour into a record's colour bits. */
export function cellRgb(rgb: number): number {
  return ((rgb >>> 16) & 0xff) | (rgb & 0xff00) | ((rgb & 0xff) << 16);
}
