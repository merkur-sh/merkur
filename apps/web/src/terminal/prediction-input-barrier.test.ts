import { describe, expect, test } from 'bun:test';

import { createPredictionInputBarrier } from './prediction-input-barrier';

describe('prediction input barrier', () => {
  test('extends across rejected input and closes only at authoritative catch-up', () => {
    const barrier = createPredictionInputBarrier();

    expect(barrier.rejectIfOpen(4)).toBe(false);
    barrier.openThrough(5);
    expect(barrier.rejectIfOpen(6)).toBe(true);
    expect(barrier.highWater()).toBe(6);

    barrier.observeAuthoritative(5);
    expect(barrier.rejectIfOpen(7)).toBe(true);
    expect(barrier.highWater()).toBe(7);
    barrier.observeAuthoritative(7);
    expect(barrier.rejectIfOpen(8)).toBe(false);
  });

  test('ignores malformed telemetry and resets at a worker lifecycle boundary', () => {
    const barrier = createPredictionInputBarrier();
    barrier.openThrough(Number.NaN);
    barrier.openThrough(0);
    expect(barrier.highWater()).toBe(0);

    barrier.openThrough(9);
    barrier.observeAuthoritative(Number.POSITIVE_INFINITY);
    expect(barrier.highWater()).toBe(9);
    barrier.reset();
    expect(barrier.highWater()).toBe(0);
  });

  test('a resize-style fence holds displaced input until the resized display catches up', () => {
    const barrier = createPredictionInputBarrier();

    // The worker fences the latest applied/queued prediction before resize
    // clears the speculative overlay.
    barrier.openThrough(12);
    expect(barrier.rejectIfOpen(13)).toBe(true);
    barrier.observeAuthoritative(12);
    expect(barrier.highWater()).toBe(13);
    barrier.observeAuthoritative(13);
    expect(barrier.highWater()).toBe(0);
  });

  test('extends and closes the causal fence in serial order across uint32 wrap', () => {
    const barrier = createPredictionInputBarrier();

    barrier.openThrough(0xffff_ffff);
    expect(barrier.rejectIfOpen(1)).toBe(true);
    expect(barrier.highWater()).toBe(1);
    barrier.observeAuthoritative(0xffff_ffff);
    expect(barrier.highWater()).toBe(1);
    barrier.observeAuthoritative(1);
    expect(barrier.highWater()).toBe(0);
  });
});
