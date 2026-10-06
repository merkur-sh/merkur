import { describe, expect, test } from 'bun:test';
import { formatLastSeen, formatLastSeenCompact } from './relative-time';

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatLastSeen', () => {
  test('reads as still happening inside the just-now window', () => {
    expect(formatLastSeen(NOW, NOW)).toBe('just now');
    expect(formatLastSeen(NOW - 44_000, NOW)).toBe('just now');
  });

  test('a server marginally ahead of this browser is never in the future', () => {
    expect(formatLastSeen(NOW + 5 * MINUTE, NOW)).toBe('just now');
  });

  test('rounds to the coarsest unit that still answers "how long ago"', () => {
    expect(formatLastSeen(NOW - 46_000, NOW)).toBe('1 min ago');
    expect(formatLastSeen(NOW - 5 * MINUTE, NOW)).toBe('5 min ago');
    expect(formatLastSeen(NOW - 59 * MINUTE, NOW)).toBe('59 min ago');
    expect(formatLastSeen(NOW - 90 * MINUTE, NOW)).toBe('2 hr ago');
    expect(formatLastSeen(NOW - 23 * HOUR, NOW)).toBe('23 hr ago');
    expect(formatLastSeen(NOW - 25 * HOUR, NOW)).toBe('yesterday');
    expect(formatLastSeen(NOW - 3 * DAY, NOW)).toBe('3 days ago');
  });

  test('falls back to a date once "how long ago" has stopped being the question', () => {
    const old = formatLastSeen(NOW - 30 * DAY, NOW);
    expect(old).not.toContain('ago');
    expect(old.length).toBeGreaterThan(0);
    // Another year needs one, and the current year would only be noise.
    expect(formatLastSeen(Date.UTC(2024, 0, 15), NOW)).toContain('2024');
    expect(formatLastSeen(NOW - 30 * DAY, NOW)).not.toContain('2026');
  });
});

describe('formatLastSeenCompact', () => {
  // One number and one unit, always: the machine list right-aligns this in a
  // mono column, and a value that is sometimes "just now" and sometimes
  // "yesterday" is prose that happens to be right-aligned rather than a column.
  test('is always one figure and one unit', () => {
    expect(formatLastSeenCompact(NOW - 1_000, NOW)).toBe('1 s');
    expect(formatLastSeenCompact(NOW - 47_000, NOW)).toBe('47 s');
    expect(formatLastSeenCompact(NOW - 5 * MINUTE, NOW)).toBe('5 m');
    expect(formatLastSeenCompact(NOW - 2 * HOUR, NOW)).toBe('2 h');
    expect(formatLastSeenCompact(NOW - 3 * DAY, NOW)).toBe('3 d');
    expect(formatLastSeenCompact(NOW - 30 * DAY, NOW)).toBe('4 w');
  });

  // A clock that stepped back, or a server slightly ahead of this browser, must
  // not render as a machine last seen in the future.
  test('never counts backwards from a clock that stepped', () => {
    expect(formatLastSeenCompact(NOW + 5_000, NOW)).toBe('1 s');
  });
});
