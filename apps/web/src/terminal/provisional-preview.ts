import type { TerminalPreviewGeometry } from '../terminal-renderer';
import { PROVISIONAL_PREVIEW_SLOTS, type ProvisionalPreviewSnapshot } from './prediction-fast-path';
import {
  SPECULATIVE_ASCII_FIRST,
  SPECULATIVE_ASCII_LAST,
  SPECULATIVE_GLYPH_ENTRIES_LENGTH,
  SPECULATIVE_GLYPH_ENTRY_HEIGHT,
  SPECULATIVE_GLYPH_ENTRY_OFFSET_X,
  SPECULATIVE_GLYPH_ENTRY_OFFSET_Y,
  SPECULATIVE_GLYPH_ENTRY_STRIDE,
  SPECULATIVE_GLYPH_ENTRY_WIDTH,
  SPECULATIVE_GLYPH_ENTRY_X,
  SPECULATIVE_GLYPH_ENTRY_Y,
} from './speculative-glyph-atlas';

export const MAX_PROVISIONAL_PREVIEWS = PROVISIONAL_PREVIEW_SLOTS;
interface ProvisionalPreviewCommand {
  readonly pointerId: number;
  readonly codepoint: number | null;
  readonly epoch: number;
  readonly modelVersion: number;
}

/** Current security grant plus the cursor/atlas of the eligible visual base. */
export interface ProvisionalPreviewAuthority {
  readonly epoch: number;
  readonly modelVersion: number;
  readonly predictionSafe: boolean;
  readonly predictionVisible: boolean;
  readonly appendOnly: boolean;
  readonly cursorVisible: boolean;
  readonly preeditActive: boolean;
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
  readonly inputSeq: number;
  readonly foreground: number;
  readonly background: number;
  readonly cursorShape: number;
  readonly atlasGeneration: number;
}

/** Borrowed already-installed atlas metadata; never prepare/repack it here. */
export interface ProvisionalPreviewAtlas {
  readonly entries: Int32Array;
  readonly generation: number;
  readonly width: number;
  readonly height: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly baseline: number;
}

/**
 * Unsent pointer choices are display-only: no input ID, prediction model op,
 * transport admission, or authoritative cell mutation. Buffers and slots have
 * fixed capacity. The caller submits them over the eligible base in the same
 * GPU pass and revalidates before every submission and security transition.
 */
export function createProvisionalPreviewState() {
  const pointers = new Float64Array(MAX_PROVISIONAL_PREVIEWS);
  const codepoints = new Uint32Array(MAX_PROVISIONAL_PREVIEWS);
  const geometry = {
    version: 1,
    bg: new Float32Array(7),
    bgCount: 0,
    glyph: new Float32Array(MAX_PROVISIONAL_PREVIEWS * 14),
    glyphCount: 0,
    cursor: new Float32Array(8),
    cursorCount: 0,
  } satisfies TerminalPreviewGeometry;
  let count = 0;
  let dirty = false;
  let epoch = 0;
  let modelVersion = 0;
  let col = 0;
  let row = 0;
  let inputSeq = 0;
  let atlasGeneration = 0;
  let foreground = 0;
  let background = 0;
  let cursorShape = 0;
  let columns = 0;
  let rows = 0;
  const updateScratch: {
    pointerId: number;
    codepoint: number | null;
    epoch: number;
    modelVersion: number;
  } = {
    pointerId: 0,
    codepoint: null,
    epoch: 0,
    modelVersion: 0,
  };

  function clear(): boolean {
    if (count === 0 && geometry.bgCount === 0) return false;
    count = 0;
    geometry.bgCount = 0;
    geometry.glyphCount = 0;
    geometry.cursorCount = 0;
    geometry.version += 1;
    dirty = false;
    return true;
  }

  function allowed(a: ProvisionalPreviewAuthority): boolean {
    return (
      a.epoch > 0 &&
      a.modelVersion > 0 &&
      (a.modelVersion & 1) === 0 &&
      a.predictionSafe &&
      a.appendOnly &&
      a.cursorVisible &&
      !a.preeditActive &&
      Number.isInteger(a.col) &&
      Number.isInteger(a.row) &&
      a.col >= 0 &&
      a.row >= 0 &&
      a.col < a.cols - 1 &&
      a.row < a.rows
    );
  }

  function reconcile(a: ProvisionalPreviewAuthority): boolean {
    if (count === 0) return false;
    if (
      !allowed(a) ||
      a.epoch !== epoch ||
      a.modelVersion !== modelVersion ||
      a.col !== col ||
      a.row !== row ||
      a.inputSeq !== inputSeq ||
      a.atlasGeneration !== atlasGeneration ||
      a.foreground !== foreground ||
      a.background !== background ||
      a.cursorShape !== cursorShape ||
      a.cols !== columns ||
      a.rows !== rows ||
      col + count >= a.cols
    )
      return clear();
    return false;
  }

  function find(pointerId: number): number {
    for (let index = 0; index < count; index += 1) if (pointers[index] === pointerId) return index;
    return -1;
  }

  const state = {
    geometry,
    count: () => count,
    clear,
    reconcile,
    /** Synchronize a complete latest pointer set; slot reuse cannot retain an old pointer. */
    synchronize(snapshot: ProvisionalPreviewSnapshot, a: ProvisionalPreviewAuthority): boolean {
      let changed = reconcile(a);
      updateScratch.epoch = a.epoch;
      updateScratch.modelVersion = 0;
      updateScratch.codepoint = null;
      for (let index = count - 1; index >= 0; index--) {
        const pointerId = pointers[index] ?? -1;
        let retained = false;
        for (let slot = 0; slot < PROVISIONAL_PREVIEW_SLOTS; slot++) {
          if (
            (snapshot.activeMask & (1 << slot)) !== 0 &&
            snapshot.pointers[slot] === pointerId &&
            snapshot.epochs[slot] === a.epoch
          ) {
            retained = true;
            break;
          }
        }
        if (!retained) {
          updateScratch.pointerId = pointerId;
          changed = state.update(updateScratch, a) || changed;
        }
      }
      for (let slot = 0; slot < PROVISIONAL_PREVIEW_SLOTS; slot++) {
        if ((snapshot.activeMask & (1 << slot)) === 0) continue;
        updateScratch.pointerId = snapshot.pointers[slot] ?? -1;
        updateScratch.codepoint = snapshot.codepoints[slot] ?? 0;
        updateScratch.epoch = snapshot.epochs[slot] ?? 0;
        updateScratch.modelVersion = snapshot.modelVersions[slot] ?? 0;
        changed = state.update(updateScratch, a) || changed;
      }
      return changed;
    },
    update(command: ProvisionalPreviewCommand, a: ProvisionalPreviewAuthority): boolean {
      let changed = reconcile(a);
      if (
        !Number.isSafeInteger(command.pointerId) ||
        command.pointerId < 0 ||
        command.epoch !== a.epoch
      )
        return changed;
      let index = find(command.pointerId);
      if (command.codepoint === null) {
        // Clearing is epoch-scoped, never dependent on a still-live grant.
        if (index < 0) return changed;
        pointers.copyWithin(index, index + 1, count);
        codepoints.copyWithin(index, index + 1, count);
        count -= 1;
        dirty = true;
        return true;
      }
      if (
        !allowed(a) ||
        // Latency/trust visibility is latched on admission. A later calibration
        // callback may gate the NEXT pointer but cannot retract this accepted
        // one; security/model/anchor changes still invalidate it in reconcile.
        !a.predictionVisible ||
        command.modelVersion !== a.modelVersion ||
        !Number.isInteger(command.codepoint) ||
        command.codepoint < SPECULATIVE_ASCII_FIRST ||
        command.codepoint > SPECULATIVE_ASCII_LAST
      )
        return changed;
      if (index < 0) {
        if (count >= MAX_PROVISIONAL_PREVIEWS || a.col + count >= a.cols - 1) return changed;
        if (count === 0) {
          epoch = a.epoch;
          modelVersion = a.modelVersion;
          col = a.col;
          row = a.row;
          inputSeq = a.inputSeq;
          atlasGeneration = a.atlasGeneration;
          foreground = a.foreground;
          background = a.background;
          cursorShape = a.cursorShape;
          columns = a.cols;
          rows = a.rows;
        }
        index = count++;
        pointers[index] = command.pointerId;
        changed = true;
      }
      if (!changed && codepoints[index] === command.codepoint) return false;
      codepoints[index] = command.codepoint;
      dirty = true;
      return true;
    },
    buildGeometry(
      a: ProvisionalPreviewAuthority,
      atlas: ProvisionalPreviewAtlas,
    ): TerminalPreviewGeometry {
      reconcile(a);
      if (count === 0) {
        clear();
        return geometry;
      }
      if (
        atlas.generation !== atlasGeneration ||
        atlas.entries.length !== SPECULATIVE_GLYPH_ENTRIES_LENGTH ||
        !Number.isFinite(atlas.width) ||
        atlas.width <= 0 ||
        !Number.isFinite(atlas.height) ||
        atlas.height <= 0 ||
        !Number.isFinite(atlas.cellWidth) ||
        atlas.cellWidth <= 0 ||
        !Number.isFinite(atlas.cellHeight) ||
        atlas.cellHeight <= 0 ||
        !Number.isFinite(atlas.baseline)
      ) {
        clear();
        return geometry;
      }
      if (!dirty) return geometry;
      const x = col * atlas.cellWidth;
      const y = row * atlas.cellHeight;
      const fr = ((a.foreground >>> 16) & 255) / 255;
      const fg = ((a.foreground >>> 8) & 255) / 255;
      const fb = (a.foreground & 255) / 255;
      const bg = geometry.bg;
      bg[0] = x;
      bg[1] = y;
      bg[2] = (count + 1) * atlas.cellWidth;
      bg[3] = atlas.cellHeight;
      bg[4] = ((a.background >>> 16) & 255) / 255;
      bg[5] = ((a.background >>> 8) & 255) / 255;
      bg[6] = (a.background & 255) / 255;
      let glyphCount = 0;
      for (let index = 0; index < count; index += 1) {
        const codepoint = codepoints[index] ?? 0;
        if (codepoint === SPECULATIVE_ASCII_FIRST) continue;
        const at = (codepoint - SPECULATIVE_ASCII_FIRST) * SPECULATIVE_GLYPH_ENTRY_STRIDE;
        const sx = atlas.entries[at + SPECULATIVE_GLYPH_ENTRY_X] ?? 0;
        const sy = atlas.entries[at + SPECULATIVE_GLYPH_ENTRY_Y] ?? 0;
        const width = atlas.entries[at + SPECULATIVE_GLYPH_ENTRY_WIDTH] ?? 0;
        const height = atlas.entries[at + SPECULATIVE_GLYPH_ENTRY_HEIGHT] ?? 0;
        const ox = atlas.entries[at + SPECULATIVE_GLYPH_ENTRY_OFFSET_X] ?? 0;
        const oy = atlas.entries[at + SPECULATIVE_GLYPH_ENTRY_OFFSET_Y] ?? 0;
        // A missing glyph never starts asynchronous raster work under a frozen
        // atlas; fail closed rather than display an empty advertised preview.
        if (
          width <= 0 ||
          height <= 0 ||
          sx < 0 ||
          sy < 0 ||
          sx + width > atlas.width ||
          sy + height > atlas.height
        ) {
          clear();
          return geometry;
        }
        const left = Math.max(x, x + index * atlas.cellWidth + ox);
        const top = Math.max(y, y + atlas.baseline + oy);
        const right = Math.min(
          x + count * atlas.cellWidth,
          x + index * atlas.cellWidth + ox + width,
        );
        const bottom = Math.min(y + atlas.cellHeight, y + atlas.baseline + oy + height);
        if (right <= left || bottom <= top) continue;
        const into = glyphCount++ * 14;
        const out = geometry.glyph;
        out[into] = left;
        out[into + 1] = top;
        out[into + 2] = 0;
        out[into + 3] = 0;
        out[into + 4] = right - left;
        out[into + 5] = bottom - top;
        out[into + 6] = (sx + left - (x + index * atlas.cellWidth + ox)) / atlas.width;
        out[into + 7] = (sy + top - (y + atlas.baseline + oy)) / atlas.height;
        out[into + 8] = (sx + right - (x + index * atlas.cellWidth + ox)) / atlas.width;
        out[into + 9] = (sy + bottom - (y + atlas.baseline + oy)) / atlas.height;
        out[into + 10] = fr;
        out[into + 11] = fg;
        out[into + 12] = fb;
        out[into + 13] = 0.55;
      }
      const cursor = geometry.cursor;
      cursor[0] = x + count * atlas.cellWidth;
      cursor[1] = y;
      cursor[2] = atlas.cellWidth;
      cursor[3] = atlas.cellHeight;
      cursor[4] = fr;
      cursor[5] = fg;
      cursor[6] = fb;
      cursor[7] = a.cursorShape;
      geometry.bgCount = 1;
      geometry.glyphCount = glyphCount;
      geometry.cursorCount = 1;
      geometry.version += 1;
      dirty = false;
      return geometry;
    },
  };
  return state;
}
