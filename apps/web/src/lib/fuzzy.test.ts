import { describe, expect, test } from 'bun:test';

import { fuzzyScore } from './fuzzy';

function rank(candidates: readonly string[], query: string): string[] {
  return candidates
    .map((candidate) => ({ candidate, score: fuzzyScore(candidate, query) }))
    .filter((entry): entry is { candidate: string; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.candidate);
}

describe('fuzzyScore', () => {
  test('accepts an exact prefix', () => {
    expect(fuzzyScore('Rename machine', 'ren')).not.toBeNull();
  });

  test('accepts a scattered subsequence', () => {
    expect(fuzzyScore('Open terminal preferences', 'otp')).not.toBeNull();
  });

  test('rejects a query that is not a subsequence', () => {
    expect(fuzzyScore('Rename machine', 'zz')).toBeNull();
    // Order matters: the letters are all present, the sequence is not.
    expect(fuzzyScore('abc', 'cba')).toBeNull();
  });

  test('an empty query matches everything at a flat score', () => {
    expect(fuzzyScore('anything', '')).toBe(0);
  });

  test('is case-insensitive in both directions', () => {
    expect(fuzzyScore('Revoke Others', 'REVOKE')).not.toBeNull();
    expect(fuzzyScore('REVOKE OTHERS', 'revoke')).not.toBeNull();
  });

  // The two ranking properties the palette actually depends on.
  test('ranks initials of words above letters buried mid-word', () => {
    expect(rank(['Nice birds', 'New box'], 'nb')[0]).toBe('New box');
  });

  test('ranks a prefix above a scattered match', () => {
    expect(rank(['Sessions in a browser', 'Sessions'], 'sess')[0]).toBe('Sessions');
  });

  test('ranks a tight run above the same letters spread out', () => {
    expect(rank(['s-t-a-r-t it', 'start'], 'start')[0]).toBe('start');
  });
});
