import { describe, expect, test } from 'bun:test';
import {
  advanceInputSequence,
  classifyInputSequenceEpoch,
  inputSequenceAdvances,
  localInputSequenceForWire,
  normalizeDisplayInputSequence,
} from './input-sequence-domain';

describe('input sequence domain', () => {
  test('bounds translation to the proven wire interval', () => {
    const mapping = {
      epoch: 3,
      localMinusWire: (100 - 1) >>> 0,
      wireMin: 1,
      wireMax: 2,
    };
    expect(localInputSequenceForWire(mapping, 1)).toBe(100);
    expect(localInputSequenceForWire(mapping, 2)).toBe(101);
    expect(localInputSequenceForWire(mapping, 0)).toBeNull();
    expect(localInputSequenceForWire(mapping, 3)).toBeNull();
    expect(normalizeDisplayInputSequence(mapping, 1)).toBe(100);
    expect(normalizeDisplayInputSequence(mapping, 3)).toBe(0);
    expect(normalizeDisplayInputSequence(mapping, 0)).toBe(0);
  });

  test('classifies stale epochs and accepts uint32 epoch wrap', () => {
    expect(classifyInputSequenceEpoch(0, 7)).toBe('advance');
    expect(classifyInputSequenceEpoch(7, 7)).toBe('current');
    expect(classifyInputSequenceEpoch(8, 7)).toBe('stale');
    expect(classifyInputSequenceEpoch(0xffff_ffff, 1)).toBe('advance');
    expect(classifyInputSequenceEpoch(1, 0xffff_ffff)).toBe('stale');
  });

  test('advances causal high-water in serial order across uint32 wrap', () => {
    expect(inputSequenceAdvances(0, 0)).toBe(false);
    expect(inputSequenceAdvances(0, 0xffff_fffe)).toBe(true);
    expect(advanceInputSequence(0, 0xffff_fffe)).toBe(0xffff_fffe);
    expect(advanceInputSequence(0xffff_fffe, 0xffff_ffff)).toBe(0xffff_ffff);
    expect(advanceInputSequence(0xffff_ffff, 1)).toBe(1);
    expect(advanceInputSequence(1, 0xffff_ffff)).toBe(1);
    expect(inputSequenceAdvances(7, 7)).toBe(false);
  });
});
