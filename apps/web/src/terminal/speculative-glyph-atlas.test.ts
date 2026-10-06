import { describe, expect, test } from 'bun:test';
import {
  SPECULATIVE_ASCII_COUNT,
  SPECULATIVE_GLYPH_ENTRIES_BYTES,
  SPECULATIVE_GLYPH_ENTRY_STRIDE,
} from './speculative-glyph-atlas';

describe('speculative glyph atlas', () => {
  test('keeps one fixed metadata record per printable ASCII codepoint', () => {
    expect(SPECULATIVE_ASCII_COUNT).toBe(95);
    expect(SPECULATIVE_GLYPH_ENTRY_STRIDE).toBe(6);
    expect(SPECULATIVE_GLYPH_ENTRIES_BYTES).toBe(95 * 6 * Int32Array.BYTES_PER_ELEMENT);
  });
});
