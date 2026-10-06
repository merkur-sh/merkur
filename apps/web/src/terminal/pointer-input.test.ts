import { describe, expect, test } from 'bun:test';

import {
  createMouseGestureOwner,
  createPointerMotionDeduper,
  terminalCaretAtPoint,
  terminalCellAtPoint,
  terminalCellAtPointInto,
} from './pointer-input';

describe('terminal pointer input', () => {
  test('maps cached viewport geometry without reading layout', () => {
    const geometry = {
      containerLeft: 100,
      containerTop: 50,
      charWidth: 10,
      charHeight: 20,
      cols: 80,
      rows: 24,
    };

    expect(terminalCellAtPoint(109, 53, geometry)).toEqual({ col: 0, row: 0 });
    expect(terminalCellAtPoint(138, 92, geometry)).toEqual({ col: 3, row: 2 });
    // The grid is anchored at the container origin: the first cell starts at
    // the container's own top-left corner and each boundary is exact.
    expect(terminalCellAtPoint(100, 50, geometry)).toEqual({ col: 0, row: 0 });
    expect(terminalCellAtPoint(110, 70, geometry)).toEqual({ col: 1, row: 1 });
    expect(terminalCellAtPoint(-1_000, -1_000, geometry)).toEqual({ col: 0, row: 0 });
    expect(terminalCellAtPoint(10_000, 10_000, geometry)).toEqual({ col: 79, row: 23 });
  });

  test('the motion path hit-tests into one caller-owned cell', () => {
    const geometry = {
      containerLeft: 100,
      containerTop: 50,
      charWidth: 10,
      charHeight: 20,
      cols: 80,
      rows: 24,
    };
    const cell = { col: -1, row: -1 };

    expect(terminalCellAtPointInto(138, 92, geometry, cell)).toBe(cell);
    expect(cell).toEqual({ col: 3, row: 2 });
    terminalCellAtPointInto(10_000, 10_000, geometry, cell);
    expect(cell).toEqual({ col: 79, row: 23 });
  });

  test('a caret takes the nearer cell edge, and may sit past the last cell', () => {
    const geometry = {
      containerLeft: 100,
      containerTop: 50,
      charWidth: 10,
      charHeight: 20,
      cols: 80,
      rows: 24,
    };

    // Inside the first cell: left of its middle anchors before it, right of it
    // anchors after — the difference between a drag that starts on the glyph
    // the pointer is on and one that starts a character off.
    expect(terminalCaretAtPoint(104, 53, geometry)).toEqual({ col: 0, row: 0 });
    expect(terminalCaretAtPoint(106, 53, geometry)).toEqual({ col: 1, row: 0 });
    // A caret has one more position than the grid has cells: the row's end.
    expect(terminalCaretAtPoint(10_000, 10_000, geometry)).toEqual({ col: 80, row: 23 });
    expect(terminalCaretAtPoint(-1_000, -1_000, geometry)).toEqual({ col: 0, row: 0 });
    // Rows still name the row the pointer is inside; only the column rounds.
    expect(terminalCaretAtPoint(138, 92, geometry)).toEqual({ col: 4, row: 2 });
  });

  test('a gesture the selection owns is never reported, press to release', () => {
    const owner = createMouseGestureOwner();

    // Shift is down (or the layer is up): the application hears nothing at all,
    // which is what stops vim starting its own selection under the browser's.
    expect(owner.press(true)).toBe(false);
    expect(owner.isApplication()).toBe(false);
    expect(owner.release()).toBe(false);
  });

  test('a release is reported to whoever was told about its press', () => {
    const owner = createMouseGestureOwner();

    expect(owner.press(false)).toBe(true);
    expect(owner.isApplication()).toBe(true);
    // Shift going down mid-drag changes nothing: ownership was decided at the
    // press, and an application told about a button must be told it was let go.
    expect(owner.isApplication()).toBe(true);
    expect(owner.release()).toBe(true);
    // The gesture is over — a second release owes nothing.
    expect(owner.release()).toBe(false);
    expect(owner.isApplication()).toBe(false);
  });

  test('a cancelled pointer ends the gesture without a release', () => {
    const owner = createMouseGestureOwner();

    owner.press(false);
    owner.reset();
    expect(owner.isApplication()).toBe(false);
    expect(owner.release()).toBe(false);
  });

  test('suppresses only duplicate same-cell motion with the same button state', () => {
    const deduper = createPointerMotionDeduper();

    expect(deduper.shouldReport({ col: 4, row: 5 }, 32)).toBe(true);
    expect(deduper.shouldReport({ col: 4, row: 5 }, 32)).toBe(false);
    expect(deduper.shouldReport({ col: 5, row: 5 }, 32)).toBe(true);
    expect(deduper.shouldReport({ col: 5, row: 5 }, 35)).toBe(true);
    deduper.reset();
    expect(deduper.shouldReport({ col: 5, row: 5 }, 35)).toBe(true);
  });
});
