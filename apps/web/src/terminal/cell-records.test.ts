import { expect, test } from 'bun:test';
import {
  BUILTIN_MOSAIC,
  CELL_ALPHA_DIM,
  CELL_ALPHA_PREDICTION,
  CELL_BACKGROUND,
  CELL_BUILTIN,
  CELL_COLUMN_SHIFT,
  CELL_GLYPH_MASK,
  CELL_PREEDIT,
  CELL_ROW_SHIFT,
  CELL_STRIKEOUT,
  CELL_UNDERLINE,
  CELL_WIDE,
  CELL_WORDS,
  cellRgb,
  GLYPH_TABLE_WORDS,
} from './cell-records';
import { GEOMETRY_STATE_LENGTH } from './geometry-render-state';

// `cell_record_layout_is_pinned` in packages/term-wasm pins the same values.
test('the cell record layout matches the terminal WASM bit for bit', () => {
  expect([
    CELL_WORDS,
    CELL_GLYPH_MASK,
    CELL_COLUMN_SHIFT,
    CELL_WIDE,
    CELL_UNDERLINE,
    CELL_STRIKEOUT,
    CELL_BUILTIN,
    CELL_BACKGROUND,
    CELL_ALPHA_DIM,
    CELL_ALPHA_PREDICTION,
    CELL_PREEDIT,
    CELL_ROW_SHIFT,
    BUILTIN_MOSAIC,
    GLYPH_TABLE_WORDS,
    GEOMETRY_STATE_LENGTH,
  ]).toEqual([
    3, 0xf_ffff, 20, 0x2000_0000, 0x4000_0000, 0x8000_0000, 0x0100_0000, 0x0200_0000, 0x0400_0000,
    0x0800_0000, 0x1000_0000, 24, 0x1_0000, 3, 25,
  ]);
});

test('colours pack red into the low byte, as the shader unpacks them', () => {
  expect(cellRgb(0x102030)).toBe(0x302010);
  expect(cellRgb(0xffffff)).toBe(0xffffff);
});
