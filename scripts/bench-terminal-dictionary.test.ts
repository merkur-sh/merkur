import { describe, expect, test } from 'bun:test';
import {
  DISPLAY_COMPRESSED_LENGTH_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_GRID_ROWS_OFFSET,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT,
  DISPLAY_ROW_COUNT_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  readU16BE,
  readU32BE,
} from '../packages/shared/src';
import {
  assertPreviousDictionaryExpectation,
  createDictionaryCompressedFrame,
  parsePreviousDictionaryExpectation,
} from './bench-terminal-dictionary';

describe('terminal dictionary benchmark harness', () => {
  test('builds the exact dictionary-compressed wire envelope', () => {
    const compressed = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
    const wire = createDictionaryCompressedFrame({
      generation: 41,
      id: 8,
      hash: 0x1234_5678,
      rowCount: 65,
      rowsBytes: 16_185,
      compressed,
    });

    expect(wire.byteLength).toBe(DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET + compressed.byteLength);
    expect(wire[1]).toBe(
      DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD | DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT,
    );
    expect(readU16BE(wire, DISPLAY_GRID_ROWS_OFFSET)).toBe(65);
    expect(readU16BE(wire, DISPLAY_ROW_COUNT_OFFSET)).toBe(65);
    expect(readU32BE(wire, DISPLAY_GENERATION_OFFSET)).toBe(41);
    expect(readU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET)).toBe(16_185);
    expect(readU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET + 4)).toBe(8);
    expect(readU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET + 8)).toBe(0x1234_5678);
    expect(readU32BE(wire, DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET)).toBe(
      wire.byteLength - DISPLAY_STREAM_HEADER_BYTES,
    );
    expect(wire.subarray(DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET)).toEqual(compressed);
  });

  test('pins baseline miss and candidate hit expectations', () => {
    expect(parsePreviousDictionaryExpectation(undefined)).toBe('either');
    expect(parsePreviousDictionaryExpectation('miss')).toBe('miss');
    expect(parsePreviousDictionaryExpectation('hit')).toBe('hit');
    expect(() => parsePreviousDictionaryExpectation('yes')).toThrow();
    expect(() => assertPreviousDictionaryExpectation(false, 'miss')).not.toThrow();
    expect(() => assertPreviousDictionaryExpectation(true, 'hit')).not.toThrow();
    expect(() => assertPreviousDictionaryExpectation(true, 'miss')).toThrow();
    expect(() => assertPreviousDictionaryExpectation(false, 'hit')).toThrow();
  });
});
