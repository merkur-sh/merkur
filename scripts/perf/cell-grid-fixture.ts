import {
  CELL_BACKGROUND,
  CELL_COLUMN_SHIFT,
  CELL_ROW_SHIFT,
  CELL_WORDS,
  GLYPH_TABLE_WORDS,
} from '../../apps/web/src/terminal/cell-records';
import {
  createGeometryRenderState,
  type GeometryRenderState,
} from '../../apps/web/src/terminal/geometry-render-state';

/**
 * An 80x30 terminal in the renderer's own geometry: every cell a glyph over a
 * per-row background, one glyph table entry over an 8x8 atlas, 10x20 cells.
 * `revise` repaints one cell (sparse) or every cell (dense) and names exactly
 * those records dirty, as a build of that change would.
 */
export function createCellGridFixture() {
  const cols = 80;
  const rows = 30;
  const cells = cols * rows;
  const words = new Uint32Array(cells * CELL_WORDS + GLYPH_TABLE_WORDS);
  const table = cells * CELL_WORDS;
  // Atlas (0, 0), 6x16, bearing (3, -16) under a baseline of 16.
  words.set([0, 6 | (16 << 16), 3 | (0xfff0 << 16)], table);
  const state: GeometryRenderState = createGeometryRenderState();
  Object.assign(state.cells, {
    ptr: 0,
    count: cells,
    version: 0,
    dirtyOffset: 0,
    dirtyCount: cells,
  });
  Object.assign(state.glyphs, { ptr: table * 4, count: 1, epoch: 1 });
  state.params.set([10, 20, 16, 0.3, 0.3, 0.3]);
  state.viewport[0] = 800;
  state.viewport[1] = 600;
  const write = (cell: number, red: number) => {
    const row = Math.floor(cell / cols);
    words[cell * CELL_WORDS] = (1 | ((cell % cols) << CELL_COLUMN_SHIFT)) >>> 0;
    words[cell * CELL_WORDS + 1] = 0xffffff | CELL_BACKGROUND;
    words[cell * CELL_WORDS + 2] = (red | (26 << 8) | (51 << 16) | (row << CELL_ROW_SHIFT)) >>> 0;
  };
  for (let cell = 0; cell < cells; cell += 1) write(cell, 0);
  return {
    memory: words,
    state,
    revise(revision: number, dense: boolean): void {
      const count = dense ? cells : 1;
      for (let cell = 0; cell < count; cell += 1) write(cell, revision % 200);
      state.cells.version = revision;
      state.cells.dirtyOffset = 0;
      state.cells.dirtyCount = count;
    },
  };
}
