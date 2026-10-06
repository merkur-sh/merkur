import { describe, expect, test } from 'bun:test';

import { createEntityId } from './index';

describe('createEntityId', () => {
  test('returns a 21-character id', () => {
    expect(createEntityId().length).toBe(21);
  });

  test('produces distinct values across 10k draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      seen.add(createEntityId());
    }
    expect(seen.size).toBe(10_000);
  });
});
