import { describe, expect, test } from 'bun:test';

import { displaySerialIsNewer, displaySerialReached } from './display-serial';

describe('display serial RFC-1982 ordering', () => {
  test('orders max-minus-one, max, and one across the skipped-zero wrap', () => {
    expect(displaySerialIsNewer(0xffff_ffff, 0xffff_fffe)).toBe(true);
    expect(displaySerialIsNewer(1, 0xffff_ffff)).toBe(true);
    expect(displaySerialIsNewer(1, 0xffff_fffe)).toBe(true);
    expect(displaySerialIsNewer(0xffff_ffff, 1)).toBe(false);
    expect(displaySerialReached(1, 0xffff_ffff)).toBe(true);
    expect(displaySerialReached(1, 0xffff_fffe)).toBe(true);
  });

  test('treats zero only as reset and rejects duplicate or half-range order', () => {
    expect(displaySerialIsNewer(1, 0)).toBe(true);
    expect(displaySerialIsNewer(0, 0xffff_ffff)).toBe(false);
    expect(displaySerialReached(0, 0)).toBe(false);
    expect(displaySerialIsNewer(7, 7)).toBe(false);
    expect(displaySerialReached(7, 7)).toBe(true);
    expect(displaySerialIsNewer(0x8000_0001, 1)).toBe(false);
    expect(displaySerialIsNewer(1, 0x8000_0001)).toBe(false);
    expect(displaySerialReached(0x8000_0001, 1)).toBe(false);
  });
});
