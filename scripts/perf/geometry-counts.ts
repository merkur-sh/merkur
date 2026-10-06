import {
  GEOMETRY_STATE_CURSOR_OFFSET,
  GEOMETRY_STATE_GLYPH_OFFSET,
} from '../../apps/web/src/terminal/geometry-render-state';
import { createGeometryStateReader } from '../../apps/web/src/wasm-loader';

/** Instance counts of one terminal's built geometry, for a benchmark's checksum. */
export interface GeometryCounts {
  glyphs(): number;
  cursors(): number;
}

/** Reads the counts from the packed geometry state, the words the renderer reads. */
export function createGeometryCountReader(
  memory: WebAssembly.Memory,
  terminal: Parameters<typeof createGeometryStateReader>[1],
): GeometryCounts {
  const read = createGeometryStateReader(memory, terminal);
  return {
    glyphs: () => read()[GEOMETRY_STATE_GLYPH_OFFSET + 1] ?? 0,
    cursors: () => read()[GEOMETRY_STATE_CURSOR_OFFSET + 1] ?? 0,
  };
}
