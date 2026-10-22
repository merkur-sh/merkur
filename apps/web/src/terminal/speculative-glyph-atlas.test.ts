import { describe, expect, test } from 'bun:test';
import {
  SPECULATIVE_ASCII_COUNT,
  SPECULATIVE_GLYPH_ENTRIES_BYTES,
  SPECULATIVE_GLYPH_ENTRIES_LENGTH,
} from './speculative-glyph-atlas';

describe('speculative glyph atlas', () => {
  test('keeps one glyph id per printable ASCII codepoint', () => {
    expect(SPECULATIVE_ASCII_COUNT).toBe(95);
    expect(SPECULATIVE_GLYPH_ENTRIES_LENGTH).toBe(95);
    expect(SPECULATIVE_GLYPH_ENTRIES_BYTES).toBe(95 * Int32Array.BYTES_PER_ELEMENT);
  });
});
