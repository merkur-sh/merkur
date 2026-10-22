import {
  GEOMETRY_STATE_CELLS_OFFSET,
  GEOMETRY_STATE_CURSOR_OFFSET,
  GEOMETRY_STATE_OVERLAY_OFFSET,
} from '../../apps/web/src/terminal/geometry-render-state';
import { createGeometryStateReader } from '../../apps/web/src/wasm-loader';

/** Counts and versions of one terminal's built geometry, for a benchmark's checksum. */
export interface GeometryCounts {
  /** Cell and overlay records, and the version of each. */
  records(): number;
  cursors(): number;
}

/** Reads the counts from the packed geometry state, the words the renderer reads. */
export function createGeometryCountReader(
  memory: WebAssembly.Memory,
  terminal: Parameters<typeof createGeometryStateReader>[1],
): GeometryCounts {
  const read = createGeometryStateReader(memory, terminal);
  return {
    records: () => {
      const state = read();
      return (
        ((state[GEOMETRY_STATE_CELLS_OFFSET + 1] ?? 0) +
          (state[GEOMETRY_STATE_CELLS_OFFSET + 2] ?? 0) +
          (state[GEOMETRY_STATE_OVERLAY_OFFSET + 1] ?? 0) +
          (state[GEOMETRY_STATE_OVERLAY_OFFSET + 2] ?? 0)) >>>
        0
      );
    },
    cursors: () => read()[GEOMETRY_STATE_CURSOR_OFFSET + 1] ?? 0,
  };
}
