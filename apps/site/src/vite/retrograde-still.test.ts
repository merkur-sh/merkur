import { describe, expect, test } from 'bun:test';

import { ORBIT, sampleAt, stars, TAIL_SAMPLES, tailWeight } from '../gfx/retrograde-orbit';
import { retrogradeStill } from './retrograde-still';

describe('the line the orb follows', () => {
  test('runs level from edge to edge, with one loop whose top is mid-page', () => {
    expect(ORBIT.across[0]).toBe(0);
    expect(ORBIT.across[ORBIT.top * 2]).toBeCloseTo(1, 12);
    expect(ORBIT.across[ORBIT.top]).toBeCloseTo(0.5, 12);
    expect(ORBIT.lift[ORBIT.top]).toBe(1);
    for (let index = 0; index < ORBIT.lift.length; index += 1) {
      const inLoop = index >= ORBIT.loopFrom && index <= ORBIT.loopTo;
      expect((ORBIT.lift[index] ?? 0) > 0).toBe(inLoop);
    }
  });

  test('backs up once, inside the loop, and is going backwards at its top', () => {
    const backwards: number[] = [];
    for (let index = 1; index < ORBIT.across.length; index += 1) {
      if ((ORBIT.across[index] ?? 0) < (ORBIT.across[index - 1] ?? 0)) backwards.push(index);
    }
    expect(backwards[0]).toBe(ORBIT.firstBackwards);
    // One unbroken stretch.
    expect(backwards.at(-1)).toBe(ORBIT.firstBackwards + backwards.length - 1);
    expect(ORBIT.firstBackwards).toBeGreaterThan(ORBIT.loopFrom);
    expect(backwards.at(-1)).toBeLessThan(ORBIT.loopTo);
    expect(backwards).toContain(ORBIT.top);
  });

  test('is crossed faster on the level than in the loop, and every moment has its sample', () => {
    const step = (index: number): number => (ORBIT.time[index] ?? 0) - (ORBIT.time[index - 1] ?? 0);
    expect(step(ORBIT.top)).toBeGreaterThan(step(1) * 3);
    for (let index = 1; index < ORBIT.time.length; index += 1) {
      expect(step(index)).toBeGreaterThan(0);
    }
    expect(sampleAt(0)).toBe(0);
    expect(sampleAt(ORBIT.time[ORBIT.top] ?? 0)).toBe(ORBIT.top);
    expect(sampleAt(((ORBIT.time[40] ?? 0) + (ORBIT.time[41] ?? 0)) / 2)).toBe(40);
    expect(sampleAt(ORBIT.duration)).toBe(ORBIT.time.length - 1);
  });

  test('has the same stars on every visit, inside the sky', () => {
    expect(stars()).toEqual(stars());
    expect(stars()).toHaveLength(120);
    for (const star of stars()) {
      for (const share of star) {
        expect(share).toBeGreaterThan(0);
        expect(share).toBeLessThan(1);
      }
    }
  });
});

describe('the still of the sky', () => {
  const still = retrogradeStill();

  test('the line is one path from the left edge to the right, level outside the loop', () => {
    expect(still.line).toMatch(/^M0 1H\.\d+L/);
    expect(still.line).toMatch(/L\.\d+ 1H1$/);
    expect(still.line).toContain('L.5 0L');
  });

  test('the light and the tail both end where the orb is held, at the top of the loop', () => {
    expect(still.lit.endsWith('L.5 0')).toBe(true);
    const strokes = [...still.tail.matchAll(/<path d="([^"]+)" stroke-opacity="([^"]+)"/g)];
    expect(strokes).toHaveLength(TAIL_SAMPLES / 10);
    expect(strokes.at(-1)?.[1]?.endsWith('L.5 0')).toBe(true);
    // Each stroke starts where the last one ended, and is brighter than it.
    for (let index = 1; index < strokes.length; index += 1) {
      const last = strokes[index - 1]?.[1]?.split('L').at(-1);
      expect(strokes[index]?.[1]?.startsWith(`M${last}L`)).toBe(true);
      expect(Number(strokes[index]?.[2])).toBeGreaterThan(Number(strokes[index - 1]?.[2]));
    }
    expect(tailWeight(TAIL_SAMPLES)).toBe(1);
  });

  test('every star is a pixel in one of the groups', () => {
    expect(
      still.stars.match(/<rect x="[\d.]+%" y="[\d.]+%" width="1" height="1"\/>/g),
    ).toHaveLength(120);
    expect(still.stars).not.toMatch(/<g[^>]*><\/g>/);
  });
});
