import { describe, expect, test } from 'bun:test';

import { nextTrapIndex } from './focus-trap';

describe('nextTrapIndex', () => {
  test('wraps forward off the last element', () => {
    expect(nextTrapIndex(3, 2, false)).toBe(0);
  });

  test('wraps backward off the first element', () => {
    expect(nextTrapIndex(3, 0, true)).toBe(2);
  });

  // Interior moves belong to the browser. Redirecting them would break
  // sequential navigation inside anything composite the dialog contains.
  test('leaves interior moves to the browser', () => {
    expect(nextTrapIndex(3, 1, false)).toBeNull();
    expect(nextTrapIndex(3, 1, true)).toBeNull();
  });

  test('does not wrap forward off the first element', () => {
    expect(nextTrapIndex(3, 0, false)).toBeNull();
  });

  test('does not wrap backward off the last element', () => {
    expect(nextTrapIndex(3, 2, true)).toBeNull();
  });

  // The background is not inert, so Tab from outside must be pulled back in
  // rather than allowed to walk into the screen behind the dialog.
  test('pulls focus back in when it has escaped the surface', () => {
    expect(nextTrapIndex(3, -1, false)).toBe(0);
    expect(nextTrapIndex(3, -1, true)).toBe(2);
  });

  test('does nothing when there is nothing to focus', () => {
    expect(nextTrapIndex(0, -1, false)).toBeNull();
    expect(nextTrapIndex(0, 0, true)).toBeNull();
  });

  // A single control is both edges at once; wrapping to itself is correct and
  // must not fall through to the browser, which would leave the surface.
  test('treats a lone control as both edges', () => {
    expect(nextTrapIndex(1, 0, false)).toBe(0);
    expect(nextTrapIndex(1, 0, true)).toBe(0);
  });
});
