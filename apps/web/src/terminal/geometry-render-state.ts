import type { GeometryVersions } from '../terminal-renderer';

export const GEOMETRY_STATE_WORDS_PER_BUFFER = 5;
export const GEOMETRY_STATE_BG_OFFSET = 0;
export const GEOMETRY_STATE_GLYPH_OFFSET = GEOMETRY_STATE_WORDS_PER_BUFFER;
export const GEOMETRY_STATE_DECO_OFFSET = GEOMETRY_STATE_WORDS_PER_BUFFER * 2;
export const GEOMETRY_STATE_CURSOR_OFFSET = GEOMETRY_STATE_WORDS_PER_BUFFER * 3;
export const GEOMETRY_STATE_GRAPHICS_REVISION = GEOMETRY_STATE_WORDS_PER_BUFFER * 4;
export const GEOMETRY_STATE_LENGTH = GEOMETRY_STATE_GRAPHICS_REVISION + 1;

interface MutableGeometryBufferRange {
  ptr: number;
  count: number;
}

export interface GeometryRenderState {
  readonly bg: MutableGeometryBufferRange;
  readonly glyph: MutableGeometryBufferRange;
  readonly deco: MutableGeometryBufferRange;
  readonly cursor: MutableGeometryBufferRange;
  readonly viewport: [number, number];
  readonly versions: GeometryVersions;
}

export function createGeometryRenderState(): GeometryRenderState {
  return {
    bg: { ptr: 0, count: 0 },
    glyph: { ptr: 0, count: 0 },
    deco: { ptr: 0, count: 0 },
    cursor: { ptr: 0, count: 0 },
    viewport: [0, 0],
    versions: {
      bg: 0,
      glyph: 0,
      deco: 0,
      cursor: 0,
      bgDirtyOffset: 0,
      bgDirtyCount: 0,
      glyphDirtyOffset: 0,
      glyphDirtyCount: 0,
      decoDirtyOffset: 0,
      decoDirtyCount: 0,
      cursorDirtyOffset: 0,
      cursorDirtyCount: 0,
    },
  };
}

export function updateGeometryRenderState(
  target: GeometryRenderState,
  packed: Uint32Array,
  viewportWidth: number,
  viewportHeight: number,
): void {
  target.bg.ptr = packed[GEOMETRY_STATE_BG_OFFSET] ?? 0;
  target.bg.count = packed[GEOMETRY_STATE_BG_OFFSET + 1] ?? 0;
  target.versions.bg = packed[GEOMETRY_STATE_BG_OFFSET + 2] ?? 0;
  target.versions.bgDirtyOffset = packed[GEOMETRY_STATE_BG_OFFSET + 3] ?? 0;
  target.versions.bgDirtyCount = packed[GEOMETRY_STATE_BG_OFFSET + 4] ?? 0;

  target.glyph.ptr = packed[GEOMETRY_STATE_GLYPH_OFFSET] ?? 0;
  target.glyph.count = packed[GEOMETRY_STATE_GLYPH_OFFSET + 1] ?? 0;
  target.versions.glyph = packed[GEOMETRY_STATE_GLYPH_OFFSET + 2] ?? 0;
  target.versions.glyphDirtyOffset = packed[GEOMETRY_STATE_GLYPH_OFFSET + 3] ?? 0;
  target.versions.glyphDirtyCount = packed[GEOMETRY_STATE_GLYPH_OFFSET + 4] ?? 0;

  target.deco.ptr = packed[GEOMETRY_STATE_DECO_OFFSET] ?? 0;
  target.deco.count = packed[GEOMETRY_STATE_DECO_OFFSET + 1] ?? 0;
  target.versions.deco = packed[GEOMETRY_STATE_DECO_OFFSET + 2] ?? 0;
  target.versions.decoDirtyOffset = packed[GEOMETRY_STATE_DECO_OFFSET + 3] ?? 0;
  target.versions.decoDirtyCount = packed[GEOMETRY_STATE_DECO_OFFSET + 4] ?? 0;

  target.cursor.ptr = packed[GEOMETRY_STATE_CURSOR_OFFSET] ?? 0;
  target.cursor.count = packed[GEOMETRY_STATE_CURSOR_OFFSET + 1] ?? 0;
  target.versions.cursor = packed[GEOMETRY_STATE_CURSOR_OFFSET + 2] ?? 0;
  target.versions.cursorDirtyOffset = packed[GEOMETRY_STATE_CURSOR_OFFSET + 3] ?? 0;
  target.versions.cursorDirtyCount = packed[GEOMETRY_STATE_CURSOR_OFFSET + 4] ?? 0;

  target.viewport[0] = viewportWidth;
  target.viewport[1] = viewportHeight;
}
