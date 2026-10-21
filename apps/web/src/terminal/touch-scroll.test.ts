import { describe, expect, test } from 'bun:test';

import { createTouchScroll } from './touch-scroll';

const CELL = 20;
/** A 120 Hz touch event interval. */
const FRAME_MS = 1000 / 120;

/** Drag from `y` by `step` pixels per event for `events` events; the notches each event sent. */
function drag(
  scroll: ReturnType<typeof createTouchScroll>,
  y: number,
  step: number,
  events: number,
): number[] {
  scroll.begin(y, 0);
  const notches: number[] = [];
  for (let index = 1; index <= events; index += 1) {
    notches.push(scroll.move(y - step * index, index * FRAME_MS, CELL));
  }
  return notches;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Every frame of a glide from `startMs` until it ends. */
function glideFrames(scroll: ReturnType<typeof createTouchScroll>, startMs: number): number[] {
  const notches: number[] = [];
  for (let timeMs = startMs + FRAME_MS; scroll.gliding; timeMs += FRAME_MS) {
    notches.push(scroll.glide(timeMs, CELL));
    expect(notches.length).toBeLessThan(10_000);
  }
  return notches;
}

describe('two-finger touch scroll', () => {
  test('a slow drag sends one notch per cell height travelled, not one per event', () => {
    const notches = drag(createTouchScroll(), 400, 2, 40);
    expect(sum(notches)).toBe(4);
    expect(notches.filter((value) => value !== 0)).toEqual([1, 1, 1, 1]);
  });

  test('a fast event sends every notch it completes and keeps the remainder', () => {
    const scroll = createTouchScroll();
    scroll.begin(400, 0);
    expect(scroll.move(330, FRAME_MS, CELL)).toBe(3);
    expect(scroll.move(320, 2 * FRAME_MS, CELL)).toBe(1);
  });

  test('fingers moving down scroll up', () => {
    const notches = drag(createTouchScroll(), 100, -10, 8);
    expect(sum(notches)).toBe(-4);
  });

  test('a flick glides on, decelerating, and ends by itself', () => {
    const scroll = createTouchScroll();
    drag(scroll, 600, 12, 10);
    const releaseMs = 10 * FRAME_MS;
    expect(scroll.release(releaseMs, CELL)).toBe(true);
    const frames = glideFrames(scroll, releaseMs);
    expect(scroll.gliding).toBe(false);
    // 12 px per 8.33 ms is 1.44 px/ms; UIKit's normal deceleration carries it
    // 1.44 / -ln(0.998) = 719 px further: 35 or 36 notches of 20 px.
    expect(sum(frames)).toBeGreaterThanOrEqual(35);
    expect(sum(frames)).toBeLessThanOrEqual(36);
    // Decelerating: the first half of the glide carries further than the second.
    const half = Math.floor(frames.length / 2);
    expect(sum(frames.slice(0, half))).toBeGreaterThan(sum(frames.slice(half)));
  });

  test('fingers that rested before lifting do not glide', () => {
    const scroll = createTouchScroll();
    drag(scroll, 600, 12, 10);
    expect(scroll.release(10 * FRAME_MS + 150, CELL)).toBe(false);
    expect(scroll.glide(10 * FRAME_MS + 160, CELL)).toBe(0);
  });

  test('touching down again catches the glide where it is', () => {
    const scroll = createTouchScroll();
    drag(scroll, 600, 12, 10);
    expect(scroll.release(10 * FRAME_MS, CELL)).toBe(true);
    scroll.glide(11 * FRAME_MS, CELL);
    scroll.begin(300, 12 * FRAME_MS);
    expect(scroll.gliding).toBe(false);
    expect(scroll.glide(13 * FRAME_MS, CELL)).toBe(0);
  });

  test('without a cell height nothing is sent', () => {
    const scroll = createTouchScroll();
    scroll.begin(400, 0);
    expect(scroll.move(300, FRAME_MS, 0)).toBe(0);
    expect(scroll.release(FRAME_MS, 0)).toBe(false);
  });
});
