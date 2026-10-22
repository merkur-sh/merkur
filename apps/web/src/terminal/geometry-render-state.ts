/**
 * The terminal WASM's packed render metadata (`geometry_state`). Cells, the
 * overlay and the cursor are each `[ptr, count, version, dirtyOffset,
 * dirtyCount]`; the glyph table is `[ptr, glyph count, epoch]`; the parameters
 * are cell width, cell height, baseline and the preedit highlight RGB as f32
 * bits; the last word is the image scene revision.
 */
export const GEOMETRY_STATE_WORDS_PER_BUFFER = 5;
export const GEOMETRY_STATE_CELLS_OFFSET = 0;
export const GEOMETRY_STATE_OVERLAY_OFFSET = GEOMETRY_STATE_WORDS_PER_BUFFER;
export const GEOMETRY_STATE_CURSOR_OFFSET = GEOMETRY_STATE_WORDS_PER_BUFFER * 2;
export const GEOMETRY_STATE_GLYPHS_OFFSET = GEOMETRY_STATE_WORDS_PER_BUFFER * 3;
export const GEOMETRY_STATE_PARAMS_OFFSET = GEOMETRY_STATE_GLYPHS_OFFSET + 3;
export const GEOMETRY_PARAMS_LENGTH = 6;
export const GEOMETRY_STATE_GRAPHICS_REVISION =
  GEOMETRY_STATE_PARAMS_OFFSET + GEOMETRY_PARAMS_LENGTH;
export const GEOMETRY_STATE_LENGTH = GEOMETRY_STATE_GRAPHICS_REVISION + 1;

/** One WASM-owned geometry buffer and the range of it the last build changed. */
export interface GeometryBuffer {
  ptr: number;
  count: number;
  version: number;
  dirtyOffset: number;
  dirtyCount: number;
}

/** The atlas glyph table the cell records index; `epoch` names its id space. */
export interface GlyphTableRange {
  ptr: number;
  count: number;
  epoch: number;
}

export interface GeometryRenderState {
  readonly cells: GeometryBuffer;
  readonly overlay: GeometryBuffer;
  readonly cursor: GeometryBuffer;
  readonly glyphs: GlyphTableRange;
  /** Cell width, cell height, baseline, preedit highlight R, G, B. */
  readonly params: Float32Array<ArrayBuffer>;
  readonly viewport: [number, number];
}

function buffer(): GeometryBuffer {
  return { ptr: 0, count: 0, version: 0, dirtyOffset: 0, dirtyCount: 0 };
}

export function createGeometryRenderState(): GeometryRenderState {
  return {
    cells: buffer(),
    overlay: buffer(),
    cursor: buffer(),
    glyphs: { ptr: 0, count: 0, epoch: 0 },
    params: new Float32Array(GEOMETRY_PARAMS_LENGTH),
    viewport: [0, 0],
  };
}

function readBuffer(target: GeometryBuffer, packed: Uint32Array, offset: number): void {
  target.ptr = packed[offset] ?? 0;
  target.count = packed[offset + 1] ?? 0;
  target.version = packed[offset + 2] ?? 0;
  target.dirtyOffset = packed[offset + 3] ?? 0;
  target.dirtyCount = packed[offset + 4] ?? 0;
}

const paramBits = new Uint32Array(GEOMETRY_PARAMS_LENGTH);
const paramValues = new Float32Array(paramBits.buffer);

export function updateGeometryRenderState(
  target: GeometryRenderState,
  packed: Uint32Array,
  viewportWidth: number,
  viewportHeight: number,
): void {
  readBuffer(target.cells, packed, GEOMETRY_STATE_CELLS_OFFSET);
  readBuffer(target.overlay, packed, GEOMETRY_STATE_OVERLAY_OFFSET);
  readBuffer(target.cursor, packed, GEOMETRY_STATE_CURSOR_OFFSET);
  target.glyphs.ptr = packed[GEOMETRY_STATE_GLYPHS_OFFSET] ?? 0;
  target.glyphs.count = packed[GEOMETRY_STATE_GLYPHS_OFFSET + 1] ?? 0;
  target.glyphs.epoch = packed[GEOMETRY_STATE_GLYPHS_OFFSET + 2] ?? 0;
  // The parameters travel as f32 bits; reinterpret them without a view over
  // WASM memory, which growth can detach.
  for (let index = 0; index < GEOMETRY_PARAMS_LENGTH; index += 1)
    paramBits[index] = packed[GEOMETRY_STATE_PARAMS_OFFSET + index] ?? 0;
  target.params.set(paramValues);
  target.viewport[0] = viewportWidth;
  target.viewport[1] = viewportHeight;
}
