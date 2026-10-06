import { expect, test } from 'bun:test';
import { linearToSrgb, srgbToLinear } from './color-space';

test('sRGB conversion preserves every eight-bit component and the transfer breakpoints', () => {
  for (let value = 0; value < 256; value += 1) {
    expect(Math.round(linearToSrgb(srgbToLinear(value / 255)) * 255)).toBe(value);
  }
  expect(srgbToLinear(0.04045)).toBeCloseTo(0.0031308, 7);
  expect(linearToSrgb(0.0031308)).toBeCloseTo(0.040449936, 9);
});

test('linear-light half coverage encodes to 188, not encoded-space midpoint 128', () => {
  expect(Math.round(linearToSrgb(0.5) * 255)).toBe(188);
  expect(srgbToLinear(128 / 255)).toBeCloseTo(0.2158605, 7);
});
