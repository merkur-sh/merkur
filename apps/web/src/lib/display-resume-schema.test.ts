import { describe, expect, test } from 'bun:test';
import { type PersistedResume, parsePersistedResume } from './display-resume-schema';

const valid: PersistedResume = {
  key: 'daemon-1:tab-1',
  daemonId: 'daemon-1',
  tabId: 'tab-1',
  generation: 7,
  seq: 11,
  cols: 120,
  rows: 40,
  chunks: [new Uint8Array([1, 2, 3])],
  mtime: 1_700_000_000_000,
};

describe('persisted display resume schema', () => {
  test('accepts only the exact current record bound to the requested daemon and tab', () => {
    expect(parsePersistedResume(valid, 'daemon-1', 'tab-1')).toEqual(valid);
    expect(parsePersistedResume({ ...valid, retired: true }, 'daemon-1', 'tab-1')).toBeNull();
    expect(parsePersistedResume(valid, 'daemon-2', 'tab-1')).toBeNull();
    expect(parsePersistedResume(valid, 'daemon-1', 'tab-2')).toBeNull();
    expect(
      parsePersistedResume({ ...valid, key: 'daemon-1:tab-2' }, 'daemon-1', 'tab-1'),
    ).toBeNull();
  });

  test('rejects malformed cursors, dimensions, and timestamps', () => {
    for (const record of [
      { ...valid, generation: 0 },
      { ...valid, generation: 0x1_0000_0000 },
      { ...valid, seq: -1 },
      { ...valid, seq: 1.5 },
      { ...valid, cols: 0 },
      { ...valid, cols: 513 },
      { ...valid, rows: 257 },
      { ...valid, cols: 512, rows: 256 },
      { ...valid, mtime: Number.NaN },
      { ...valid, mtime: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(parsePersistedResume(record, 'daemon-1', 'tab-1')).toBeNull();
    }
  });

  test('rejects malformed, empty, excessive, and oversized chunk collections', () => {
    expect(parsePersistedResume({ ...valid, chunks: [] }, 'daemon-1', 'tab-1')).toBeNull();
    expect(
      parsePersistedResume({ ...valid, chunks: [new Uint8Array()] }, 'daemon-1', 'tab-1'),
    ).toBeNull();
    expect(parsePersistedResume({ ...valid, chunks: [[1, 2, 3]] }, 'daemon-1', 'tab-1')).toBeNull();
    expect(
      parsePersistedResume(
        {
          ...valid,
          rows: 1,
          chunks: [new Uint8Array([1]), new Uint8Array([2])],
        },
        'daemon-1',
        'tab-1',
      ),
    ).toBeNull();
    expect(
      parsePersistedResume(
        { ...valid, chunks: [new Uint8Array(2 * 1024 * 1024 + 1)] },
        'daemon-1',
        'tab-1',
      ),
    ).toBeNull();
  });
});
