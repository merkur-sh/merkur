import { describe, expect, test } from 'bun:test';

import {
  createOrbAnimation,
  ORB_FRAME_MS,
  ORB_REST_TIME,
  type OrbFrameSlot,
  type OrbSurface,
  octavesFor,
} from './orb';

function harness() {
  const drawn: number[] = [];
  const surface: OrbSurface = { draw: (time) => drawn.push(time), destroy: () => {} };
  let pending: (() => void) | null = null;
  let cancels = 0;
  const slot: OrbFrameSlot = {
    arm: (callback) => {
      pending = callback;
    },
    cancel: () => {
      pending = null;
      cancels += 1;
    },
  };
  let clock = 1000;
  const animation = createOrbAnimation(surface, slot, () => clock);
  return {
    animation,
    drawn,
    advance(ms: number) {
      clock += ms;
      const callback = pending;
      pending = null;
      callback?.();
    },
    armed: () => pending !== null,
    cancels: () => cancels,
  };
}

describe('createOrbAnimation', () => {
  test('draws the rest frame at once, before it is running', () => {
    const h = harness();
    expect(h.drawn).toEqual([ORB_REST_TIME]);
    expect(h.armed()).toBe(false);
  });

  test('advances from the rest time, throttled to ORB_FRAME_MS', () => {
    const h = harness();
    h.animation.setRunning(true);
    h.advance(ORB_FRAME_MS - 1);
    expect(h.drawn).toEqual([ORB_REST_TIME]);
    expect(h.armed()).toBe(true);
    h.advance(1);
    expect(h.drawn).toEqual([ORB_REST_TIME, ORB_REST_TIME + ORB_FRAME_MS / 1000]);
  });

  test('stops drawing when not running and resumes on the same clock', () => {
    const h = harness();
    h.animation.setRunning(true);
    h.animation.setRunning(false);
    expect(h.armed()).toBe(false);
    h.advance(500);
    expect(h.drawn).toEqual([ORB_REST_TIME]);
    h.animation.setRunning(true);
    h.advance(0);
    expect(h.drawn.at(-1)).toBe(ORB_REST_TIME + 0.5);
  });

  test('stop cancels the armed frame', () => {
    const h = harness();
    h.animation.setRunning(true);
    h.animation.stop();
    expect(h.armed()).toBe(false);
    expect(h.cancels()).toBe(1);
  });
});

describe('octavesFor', () => {
  test('keeps two to four octaves across the sizes the mark is drawn at', () => {
    expect(octavesFor(44)).toBe(2);
    expect(octavesFor(60)).toBe(2);
    expect(octavesFor(128)).toBe(4);
    expect(octavesFor(384)).toBe(4);
  });
});
