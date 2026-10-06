import { describe, expect, test } from 'bun:test';
import { resizeDisplaySurface } from './display-surface';

describe('resizeDisplaySurface', () => {
  test('font-metric resize updates the canvas backing store and renderer atomically', () => {
    const canvas = { width: 800, height: 600 };
    const calls: Array<[number, number]> = [];
    resizeDisplaySurface(
      canvas,
      {
        resize(width, height) {
          calls.push([width, height]);
        },
      },
      960,
      720,
    );

    expect(canvas).toEqual({ width: 960, height: 720 });
    expect(calls).toEqual([[960, 720]]);
  });

  test('same-size updates do not clear the canvas or reset the renderer', () => {
    const canvas = { width: 800, height: 600 };
    const calls: Array<[number, number]> = [];

    const changed = resizeDisplaySurface(
      canvas,
      {
        resize(width, height) {
          calls.push([width, height]);
        },
      },
      800,
      600,
    );

    expect(changed).toBe(false);
    expect(calls).toEqual([]);
  });
});
