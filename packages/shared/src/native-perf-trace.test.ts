import { describe, expect, test } from 'bun:test';
import {
  createNativePerfTraceValidator,
  isNativePerfTraceChunk,
  NATIVE_PERF_TRACE_KINDS,
  NATIVE_PERF_TRACE_MAX_RECORDS,
  type NativePerfTraceChunk,
} from './native-perf-trace';

function chunks(count = 129): NativePerfTraceChunk[] {
  return Array.from({ length: Math.max(1, Math.ceil(count / 128)) }, (_, index) => ({
    command_id: 'capture-1',
    owner: 7,
    peer_id: 'peer-1',
    session_id: 'session-1',
    observation_epoch: 3,
    attempted: count + 2,
    dropped: 2,
    stale: 1,
    record_count: count,
    first_ordinal: count === 0 ? 0 : 10,
    last_ordinal: count === 0 ? 0 : 10 + (count - 1) * 2,
    chunk_index: index,
    chunk_count: Math.max(1, Math.ceil(count / 128)),
    records: Array.from({ length: Math.min(128, count - index * 128) }, (_, offset) => ({
      ordinal: 10 + (index * 128 + offset) * 2,
      owner: 7,
      // Clock sampling can precede reservation on another thread.
      at_us: count - (index * 128 + offset),
      kind: 'display_attempt' as const,
      fields: Array.from({ length: 16 }, (_, field) => field),
    })),
  }));
}

function firstChunk(count = 129): NativePerfTraceChunk {
  const first = chunks(count)[0];
  if (first === undefined) throw new Error('missing fixture chunk');
  return first;
}

describe('bounded native performance trace contract', () => {
  test('accepts every native boundary kind including QUIC packet evidence', () => {
    const chunk = firstChunk(1);
    const record = chunk.records[0];
    if (record === undefined) throw new Error('missing fixture record');
    for (const kind of NATIVE_PERF_TRACE_KINDS) {
      expect(isNativePerfTraceChunk({ ...chunk, records: [{ ...record, kind }] })).toBe(true);
    }
  });
  test('accepts empty and capacity-sized captures, ordinal gaps and unsorted clocks', () => {
    for (const count of [0, 1, 128, 129, NATIVE_PERF_TRACE_MAX_RECORDS]) {
      const validator = createNativePerfTraceValidator('capture-1');
      expect(validator.complete).toBe(false);
      for (const chunk of chunks(count)) {
        expect(isNativePerfTraceChunk(chunk)).toBe(true);
        expect(validator.accept(chunk)).toBe(true);
      }
      // Export completeness deliberately does not imply zero dropped/stale records.
      expect(validator.complete).toBe(true);
      expect(validator.recordCount).toBe(count);
      expect(validator.chunkCount).toBe(Math.max(1, Math.ceil(count / 128)));
    }
  });

  test('rejects malformed, expanded and unsafe integer contracts', () => {
    const chunk = firstChunk(1);
    const record = chunk.records[0];
    if (record === undefined) throw new Error('missing fixture record');
    const invalid: unknown[] = [
      null,
      {},
      { ...chunk, extra: 1 },
      { ...chunk, command_id: '' },
      { ...chunk, peer_id: 'a'.repeat(257) },
      { ...chunk, owner: 0 },
      { ...chunk, observation_epoch: 0 },
      { ...chunk, observation_epoch: 2 ** 32 },
      { ...chunk, attempted: Number.MAX_SAFE_INTEGER + 1 },
      { ...chunk, stale: -1 },
      { ...chunk, dropped: 0.5 },
      { ...chunk, attempted: chunk.attempted + 1 },
      { ...chunk, record_count: NATIVE_PERF_TRACE_MAX_RECORDS + 1 },
      { ...chunk, chunk_index: 1 },
      { ...chunk, chunk_count: 2 },
      { ...chunk, first_ordinal: 0 },
      { ...chunk, last_ordinal: 9 },
      { ...chunk, records: [] },
      ...[
        { ...record, extra: 1 },
        { ...record, owner: 8 },
        { ...record, kind: 'raw_terminal_text' },
        { ...record, at_us: Number.NaN },
        { ...record, fields: Array(15).fill(0) },
        { ...record, fields: Array(17).fill(0) },
        { ...record, fields: Array(16).fill(Number.MAX_SAFE_INTEGER + 1) },
        { ...record, ordinal: 9 },
      ].map((entry) => ({ ...chunk, records: [entry] })),
    ];
    for (const value of invalid) expect(isNativePerfTraceChunk(value)).toBe(false);
    expect(isNativePerfTraceChunk({ ...firstChunk(0), first_ordinal: 1 })).toBe(false);
  });

  test('requires one exact FIFO capture with immutable metadata and sticky rejection', () => {
    const [first, last] = chunks();
    if (first === undefined || last === undefined) throw new Error('missing fixture chunks');
    for (const changed of [
      { ...last, command_id: 'foreign' },
      { ...last, peer_id: 'foreign' },
      { ...last, observation_epoch: 4 },
      { ...last, stale: 2 },
      { ...last, attempted: last.attempted + 1, dropped: last.dropped + 1 },
      { ...last, first_ordinal: 11 },
      { ...last, chunk_index: 0 },
    ]) {
      const validator = createNativePerfTraceValidator('capture-1');
      expect(validator.accept(first)).toBe(true);
      expect(validator.complete).toBe(false);
      expect(validator.accept(changed)).toBe(false);
      expect(validator.accept(last)).toBe(false);
      expect(validator.complete).toBe(false);
    }
    const reordered = createNativePerfTraceValidator('capture-1');
    expect(reordered.accept(last)).toBe(false);
    const duplicate = createNativePerfTraceValidator('capture-1');
    expect(duplicate.accept(first)).toBe(true);
    expect(duplicate.accept(first)).toBe(false);
    expect(duplicate.complete).toBe(false);
  });

  test('rejects cross-chunk ordinal overlap even when each chunk is valid', () => {
    const [first, last] = chunks();
    if (first === undefined || last === undefined) throw new Error('missing fixture chunks');
    const records = first.records.map((record, index) => ({
      ...record,
      ordinal: index === 127 ? first.last_ordinal : record.ordinal,
    }));
    const overlapping = { ...first, records };
    expect(isNativePerfTraceChunk(overlapping)).toBe(true);
    expect(isNativePerfTraceChunk(last)).toBe(true);
    const validator = createNativePerfTraceValidator('capture-1');
    expect(validator.accept(overlapping)).toBe(true);
    expect(validator.accept(last)).toBe(false);
  });
});
