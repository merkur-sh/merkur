const MIN_TERMINAL_DIMENSION = 1;
export const MAX_TERMINAL_COLUMNS = 512;
export const MAX_TERMINAL_ROWS = 256;
export const MAX_TERMINAL_CELLS = 96 * 1024;

export function clampTerminalDimension(value: number): number {
  if (!Number.isInteger(value) || value < MIN_TERMINAL_DIMENSION) {
    return MIN_TERMINAL_DIMENSION;
  }

  return value;
}

export function clampTerminalDimensions(
  columns: number,
  rows: number,
): { readonly columns: number; readonly rows: number } {
  const boundedColumns = Math.min(clampTerminalDimension(columns), MAX_TERMINAL_COLUMNS);
  let boundedRows = Math.min(clampTerminalDimension(rows), MAX_TERMINAL_ROWS);
  if (boundedColumns * boundedRows > MAX_TERMINAL_CELLS) {
    boundedRows = Math.max(MIN_TERMINAL_DIMENSION, Math.floor(MAX_TERMINAL_CELLS / boundedColumns));
  }
  return { columns: boundedColumns, rows: boundedRows };
}

/**
 * Viewport pixels to a terminal grid. The single owner of that rule; the Rust
 * twin in `term-wasm` picks the startup grid from the same vectors.
 *
 * Both axes floor, so the grid is always the largest one that *fits*. Rows
 * previously rounded, which produced a grid up to half a cell taller than the
 * box that measured it and left the terminal container clipping its own bottom
 * row on roughly half of all viewport heights.
 *
 * Total by construction — a zero, negative, or non-finite input falls through
 * `clampTerminalDimensions` to the minimum grid rather than producing a
 * fractional or negative one.
 */
export function computeTerminalGrid(
  width: number,
  height: number,
  charWidth: number,
  charHeight: number,
): { readonly columns: number; readonly rows: number } {
  return clampTerminalDimensions(Math.floor(width / charWidth), Math.floor(height / charHeight));
}
