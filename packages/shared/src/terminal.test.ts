import { describe, expect, test } from 'bun:test';

import {
  clampTerminalDimensions,
  computeTerminalGrid,
  MAX_TERMINAL_CELLS,
  MAX_TERMINAL_COLUMNS,
  MAX_TERMINAL_ROWS,
} from './terminal';

describe('terminal dimensions', () => {
  test('preserves ordinary dimensions', () => {
    expect(clampTerminalDimensions(120, 40)).toEqual({ columns: 120, rows: 40 });
  });

  test('clamps each dimension and the total cell count', () => {
    const dimensions = clampTerminalDimensions(2_000, 2_000);
    expect(dimensions.columns).toBe(MAX_TERMINAL_COLUMNS);
    expect(dimensions.rows).toBeLessThanOrEqual(MAX_TERMINAL_ROWS);
    expect(dimensions.columns * dimensions.rows).toBeLessThanOrEqual(MAX_TERMINAL_CELLS);
  });

  test('normalizes invalid dimensions to one', () => {
    expect(clampTerminalDimensions(Number.NaN, 0)).toEqual({ columns: 1, rows: 1 });
  });
});

describe('computeTerminalGrid', () => {
  test('divides an exact viewport into whole cells', () => {
    expect(computeTerminalGrid(960, 640, 8, 16)).toEqual({ columns: 120, rows: 40 });
  });

  test('floors sub-cell horizontal slack away', () => {
    expect(computeTerminalGrid(967, 640, 8, 16)).toEqual({ columns: 120, rows: 40 });
  });

  test('floors sub-cell vertical slack away on both sides of the half cell', () => {
    expect(computeTerminalGrid(960, 647, 8, 16)).toEqual({ columns: 120, rows: 40 });
    expect(computeTerminalGrid(960, 649, 8, 16)).toEqual({ columns: 120, rows: 40 });
  });

  // The invariant the floor/round asymmetry used to break: a rounded-up row
  // count made the grid taller than the box that measured it, and the
  // terminal container clipped the bottom row.
  test('never returns a grid larger than the viewport that measured it', () => {
    for (let height = 200; height <= 260; height += 1) {
      for (let width = 400; width <= 420; width += 1) {
        const grid = computeTerminalGrid(width, height, 8.5, 17.25);
        expect(grid.columns * 8.5).toBeLessThanOrEqual(width);
        expect(grid.rows * 17.25).toBeLessThanOrEqual(height);
      }
    }
  });

  test('clamps an oversized viewport through the cell budget', () => {
    const grid = computeTerminalGrid(100_000, 100_000, 8, 16);
    expect(grid.columns).toBe(MAX_TERMINAL_COLUMNS);
    expect(grid.rows).toBeLessThanOrEqual(MAX_TERMINAL_ROWS);
    expect(grid.columns * grid.rows).toBeLessThanOrEqual(MAX_TERMINAL_CELLS);
  });

  test('normalizes an unmeasured viewport and unmeasured cell metrics', () => {
    expect(computeTerminalGrid(0, 0, 8, 16)).toEqual({ columns: 1, rows: 1 });
    expect(computeTerminalGrid(960, 640, 0, 0)).toEqual({ columns: 1, rows: 1 });
  });
});
