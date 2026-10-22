/**
 * Upload versions and dirty instance ranges of the archived renderers'
 * per-buffer geometry (backgrounds, glyphs, decorations, cursor). The current
 * terminal renderer draws cell records instead; only the archived WebGL
 * source and the frozen WebGPU experiment still take these.
 */
export interface GeometryVersions {
  bg: number;
  glyph: number;
  deco: number;
  cursor: number;
  bgDirtyOffset: number;
  bgDirtyCount: number;
  glyphDirtyOffset: number;
  glyphDirtyCount: number;
  decoDirtyOffset: number;
  decoDirtyCount: number;
  cursorDirtyOffset: number;
  cursorDirtyCount: number;
}
