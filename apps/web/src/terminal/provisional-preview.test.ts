import { expect, test } from 'bun:test';
import {
  CELL_ALPHA_PREDICTION,
  CELL_BACKGROUND,
  CELL_COLUMN_SHIFT,
  CELL_ROW_SHIFT,
} from './cell-records';
import {
  createPredictionFastPathBuffer,
  createPredictionFastPathConsumer,
  createPredictionFastPathWriter,
} from './prediction-fast-path';
import {
  createProvisionalPreviewState,
  type ProvisionalPreviewAtlas,
  type ProvisionalPreviewAuthority,
} from './provisional-preview';
import { SPECULATIVE_GLYPH_ENTRIES_LENGTH } from './speculative-glyph-atlas';

function authority(): ProvisionalPreviewAuthority {
  return {
    epoch: 1,
    modelVersion: 2,
    predictionSafe: true,
    predictionVisible: true,
    appendOnly: true,
    cursorVisible: true,
    preeditActive: false,
    col: 2,
    row: 1,
    cols: 80,
    rows: 24,
    inputSeq: 7,
    foreground: 0xffffff,
    background: 0x102030,
    cursorShape: 1,
    atlasGeneration: 1,
  };
}
function atlas(): ProvisionalPreviewAtlas {
  // Glyph id `codepoint + 100`; the space draws nothing.
  const entries = Int32Array.from({ length: SPECULATIVE_GLYPH_ENTRIES_LENGTH }, (_, index) =>
    index === 0 ? 0 : 0x20 + index + 100,
  );
  return {
    entries,
    generation: 1,
    cellWidth: 8,
    cellHeight: 16,
  };
}
function command(pointerId = 1, codepoint: number | null = 0x61) {
  return {
    kind: 'provisional_printable' as const,
    pointerId,
    codepoint,
    epoch: 1,
    modelVersion: 2,
  };
}

test('one unsent pointer builds bounded supplemental geometry without changing authority', () => {
  const state = createProvisionalPreviewState();
  const a = Object.freeze(authority());
  expect(state.update(command(), a)).toBe(true);
  const geometry = state.buildGeometry(a, atlas());
  // The previewed cell, then the cursor cell it pushes right.
  expect(geometry.cellCount).toBe(2);
  expect(geometry.cursorCount).toBe(1);
  const background = (0x302010 | (1 << CELL_ROW_SHIFT)) >>> 0;
  expect(Array.from(geometry.cells.slice(0, 6))).toEqual([
    (0x61 + 100) | (2 << CELL_COLUMN_SHIFT),
    0xffffff | CELL_BACKGROUND | CELL_ALPHA_PREDICTION,
    background,
    3 << CELL_COLUMN_SHIFT,
    CELL_BACKGROUND,
    background,
  ]);
  expect(Array.from(geometry.clip)).toEqual([16, 16, 8, 16]);
  expect(a.inputSeq).toBe(7);
  expect(Array.from(geometry.cursor.slice(0, 2))).toEqual([24, 16]);
});

test('every safety/visibility/cursor/composition gate fails closed', () => {
  for (const change of [
    { predictionSafe: false },
    { predictionVisible: false },
    { appendOnly: false },
    { cursorVisible: false },
    { preeditActive: true },
    { col: 79 },
    { row: 24 },
  ]) {
    const state = createProvisionalPreviewState();
    expect(state.update(command(), { ...authority(), ...change })).toBe(false);
    expect(state.count()).toBe(0);
    expect(state.geometry.cellCount).toBe(0);
  }
});

test('stale down cannot cross model or epoch lineage, while clear is not grant gated', () => {
  const state = createProvisionalPreviewState();
  const a = authority();
  expect(state.update({ ...command(), modelVersion: 4 }, a)).toBe(false);
  expect(state.update({ ...command(), epoch: 2 }, a)).toBe(false);
  state.update(command(), a);
  state.buildGeometry(a, atlas());
  expect(
    state.update({ ...command(1, null), modelVersion: 0 }, { ...a, predictionSafe: false }),
  ).toBe(true);
  expect(state.geometry.cellCount).toBe(0);
  expect(state.count()).toBe(0);
});

test('latency visibility changes gate new pointers without retracting an admitted preview', () => {
  const state = createProvisionalPreviewState();
  const a = authority();
  state.update(command(), a);
  const built = state.buildGeometry(a, atlas());
  const version = built.version;
  const hidden = { ...a, predictionVisible: false };
  expect(state.reconcile(hidden)).toBe(false);
  expect(state.buildGeometry(hidden, atlas()).version).toBe(version);
  expect(state.count()).toBe(1);
  expect(state.update(command(2, 0x62), hidden)).toBe(false);
  expect(state.count()).toBe(1);
  expect(state.reconcile({ ...hidden, predictionSafe: false })).toBe(true);
  expect(state.geometry.cellCount).toBe(0);
});

test('every changed eligible anchor invalidates already built preview geometry', () => {
  for (const change of [
    { epoch: 2 },
    { modelVersion: 4 },
    { col: 3 },
    { row: 2 },
    { inputSeq: 8 },
    { atlasGeneration: 2 },
    { foreground: 0xff0000 },
    { background: 0x00ff00 },
    { cursorShape: 2 },
    { cols: 79 },
    { rows: 23 },
  ]) {
    const state = createProvisionalPreviewState();
    const a = authority();
    state.update(command(), a);
    state.buildGeometry(a, atlas());
    expect(state.reconcile({ ...a, ...change })).toBe(true);
    expect(state.geometry.cellCount).toBe(0);
    expect(state.geometry.cursorCount).toBe(0);
  }
});

test('ten pointers and one stable buffer set are a hard bound; updates preserve ordering', () => {
  const state = createProvisionalPreviewState();
  const a = authority();
  const cells = state.geometry.cells;
  const clip = state.geometry.clip;
  const cursor = state.geometry.cursor;
  for (let i = 0; i < 10; i += 1) expect(state.update(command(i), a)).toBe(true);
  expect(state.update(command(11), a)).toBe(false);
  expect(state.count()).toBe(10);
  expect(state.buildGeometry(a, atlas()).cellCount).toBe(11);
  expect(state.geometry.clip[2]).toBe(80);
  state.update(command(4, null), a);
  expect(state.buildGeometry(a, atlas()).cellCount).toBe(10);
  for (let i = 0; i < 100; i += 1) {
    state.update(command(0, 0x61 + (i % 2)), a);
    state.buildGeometry(a, atlas());
    expect(state.geometry.cells).toBe(cells);
    expect(state.geometry.clip).toBe(clip);
    expect(state.geometry.cursor).toBe(cursor);
  }
});

test('missing or mismatched atlas fails closed without requesting raster work', () => {
  for (const change of [
    { generation: 2 },
    { cellWidth: 0 },
    { entries: new Int32Array(SPECULATIVE_GLYPH_ENTRIES_LENGTH) },
  ]) {
    const state = createProvisionalPreviewState();
    const a = authority();
    state.update(command(), a);
    expect(state.buildGeometry(a, { ...atlas(), ...change }).cellCount).toBe(0);
    expect(state.count()).toBe(0);
  }
});

test('last pointer clear removes its geometry and stale epoch clear cannot erase a successor', () => {
  const state = createProvisionalPreviewState();
  const a = authority();
  state.update(command(), a);
  state.buildGeometry(a, atlas());
  expect(state.update({ ...command(1, null), epoch: 2 }, a)).toBe(false);
  expect(state.count()).toBe(1);
  state.update(command(1, null), a);
  expect(state.buildGeometry(a, atlas()).cellCount).toBe(0);
});

test('full SAB snapshot synchronization removes reused slots and rejects stale model choices', () => {
  const sab = createPredictionFastPathBuffer();
  const writer = createPredictionFastPathWriter(sab);
  const consumer = createPredictionFastPathConsumer(sab);
  writer.beginEpoch();
  consumer.adoptRequiredEpoch();
  const state = createProvisionalPreviewState();
  let a = authority();
  const drain = () =>
    consumer.drainProvisionalPreviews((snapshot) => state.synchronize(snapshot, a));
  writer.writeProvisional(1, 0x61, 1, 2);
  drain();
  state.buildGeometry(a, atlas());
  expect(state.count()).toBe(1);
  writer.writeProvisional(1, null, 1, 0);
  writer.writeProvisional(2, 0x62, 1, 2);
  drain();
  state.buildGeometry(a, atlas());
  expect(state.count()).toBe(1);
  // The retired pointer cannot clear the successor that reused its SAB slot.
  state.update(command(1, null), a);
  expect(state.count()).toBe(1);
  writer.writeProvisional(2, null, 1, 0);
  drain();
  state.buildGeometry(a, atlas());
  expect(state.geometry.cellCount).toBe(0);
  writer.writeProvisional(3, 0x63, 1, 2);
  a = { ...a, modelVersion: 4 };
  drain();
  state.buildGeometry(a, atlas());
  expect(state.count()).toBe(0);
  writer.writeProvisional(3, 0x63, 1, 4);
  drain();
  state.buildGeometry(a, atlas());
  expect(state.count()).toBe(1);
  writer.beginEpoch();
  consumer.adoptRequiredEpoch();
  a = { ...a, epoch: 2 };
  drain();
  state.buildGeometry(a, atlas());
  expect(state.count()).toBe(0);
  expect(state.geometry.cellCount).toBe(0);
});
