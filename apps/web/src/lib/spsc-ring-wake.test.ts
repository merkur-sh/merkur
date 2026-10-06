import { describe, expect, test } from 'bun:test';

import { readerNeedsWakeAfterPublish } from './spsc-ring-wake';

describe('SPSC ring publication wake', () => {
  test('wakes an already-empty reader', () => {
    expect(readerNeedsWakeAfterPublish(24, 24, 24)).toBe(true);
  });

  test('wakes when the consumer drains and parks during publication', () => {
    // The producer first observes unread data at [8, 24). While it copies the
    // next entry, the consumer advances to the old write cursor and parks.
    expect(readerNeedsWakeAfterPublish(24, 8, 24)).toBe(true);
  });

  test('does not post redundant task edges while unread data remains', () => {
    expect(readerNeedsWakeAfterPublish(24, 8, 16)).toBe(false);
  });
});
