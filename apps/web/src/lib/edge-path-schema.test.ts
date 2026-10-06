import { describe, expect, test } from 'bun:test';

import { parsePersistedEdgePath } from './edge-path-schema';

const VALID = {
  daemonId: 'daemon-a',
  edgeWtUrl: 'https://fra-1.edge.example:4433/',
  certHashes: ['hash-a', 'hash-b'],
  mtime: 1,
};

describe('persisted edge path', () => {
  test('a well-formed record round-trips', () => {
    const parsed = parsePersistedEdgePath(VALID, 'daemon-a');
    expect(parsed?.edgeWtUrl).toBe(VALID.edgeWtUrl);
    expect(parsed?.certHashes).toEqual(['hash-a', 'hash-b']);
  });

  /**
   * The record is keyed by daemon, so a value read back under a different key
   * is a corrupted store rather than a usable hint — and adopting it would aim
   * a speculative dial at another machine's edge.
   */
  test('a record whose daemon id disagrees with its key is refused', () => {
    expect(parsePersistedEdgePath(VALID, 'daemon-b')).toBeNull();
  });

  /**
   * Only an https origin can be dialled. Refusing anything else here keeps a
   * corrupted or tampered record from becoming a request somewhere else.
   */
  test('a non-https url is refused', () => {
    expect(
      parsePersistedEdgePath({ ...VALID, edgeWtUrl: 'http://edge.example/' }, 'daemon-a'),
    ).toBeNull();
    expect(
      parsePersistedEdgePath({ ...VALID, edgeWtUrl: 'javascript:alert(1)' }, 'daemon-a'),
    ).toBeNull();
  });

  test('an empty or oversized hash set is refused', () => {
    expect(parsePersistedEdgePath({ ...VALID, certHashes: [] }, 'daemon-a')).toBeNull();
    expect(
      parsePersistedEdgePath(
        { ...VALID, certHashes: Array.from({ length: 9 }, (_v, i) => `h${i}`) },
        'daemon-a',
      ),
    ).toBeNull();
    expect(parsePersistedEdgePath({ ...VALID, certHashes: ['ok', 3] }, 'daemon-a')).toBeNull();
  });

  /**
   * Exact key set: an unknown field means the record was written by a shape
   * this build does not understand, and a partial adoption of it would be worse
   * than re-learning the coordinates on the next connect.
   */
  test('unknown or missing keys reject the whole record', () => {
    expect(parsePersistedEdgePath({ ...VALID, extra: 1 }, 'daemon-a')).toBeNull();
    const { mtime: _dropped, ...withoutMtime } = VALID;
    expect(parsePersistedEdgePath(withoutMtime, 'daemon-a')).toBeNull();
  });

  test('non-records are refused', () => {
    for (const value of [null, undefined, 'x', 3, [VALID]]) {
      expect(parsePersistedEdgePath(value, 'daemon-a')).toBeNull();
    }
  });
});
