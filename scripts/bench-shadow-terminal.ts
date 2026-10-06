import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DISPLAY_CLOSURE_DIGEST_OFFSET,
  DISPLAY_COLOR_MODE_INDEXED,
  DISPLAY_ECHO_HORIZON_OFFSET,
  DISPLAY_PATCH_BODY_HEADER_BYTES,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_PREFIX_BYTES,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SCROLL_SERIAL_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  TERMINAL_MODE_PREDICTION_SAFE,
} from '@merkur/shared';
import { DEFAULT_TERMINAL_FONT } from '../apps/web/src/terminal/fonts';
import { createGeometryCountReader } from './perf/geometry-counts';
import { emitPerfMetric, perfEnvInteger, summarizeSamples } from './perf/harness';

const ROOT = path.resolve(import.meta.dir, '..');
const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 500);
const ACTIONS_PER_SAMPLE = perfEnvInteger('BENCH_ACTIONS_PER_SAMPLE', 100);
const PROJECTIONS_PER_SAMPLE = perfEnvInteger('BENCH_PROJECTIONS_PER_SAMPLE', 20);
const UNCHANGED_BUILDS_PER_SAMPLE = perfEnvInteger('BENCH_UNCHANGED_BUILDS_PER_SAMPLE', 500);
const RECONCILE_SAMPLES = Math.min(SAMPLES, 100);
// Near the 256-op model bound: 120 cursor-left + insert/backspace + 120
// cursor-right operations exercise a dense full-row projection without
// crossing the fail-closed journal limit.
const LONG_MIDLINE_CELLS = 120;
const PREDICTION_SAFE_MODE = TERMINAL_MODE_PREDICTION_SAFE;
const LETTER_A_CODE_POINT = 0x61;

const fontUrl = new URL(DEFAULT_TERMINAL_FONT.regular, 'https://merkur.local');
const fontBytes = new Uint8Array(
  await readFile(path.join(ROOT, 'apps', 'web', 'public', fontUrl.pathname)),
);
const wasmBytes = new Uint8Array(
  await readFile(path.join(ROOT, 'apps', 'web', 'src', 'term-wasm', 'pkg', 'term_wasm_bg.wasm')),
);
const wasm = await import('../apps/web/src/term-wasm/pkg/term_wasm.js');
const { memory } = wasm.initSync({ module: wasmBytes });

validateTimedBatchesAccepted();

let checksum = 0;
const actionTerminal = createTrainedTerminal();
let actionInputSeq = 2;
let actionDisplaySeq = 2;
const actionSamples: number[] = [];
for (let sample = 0; sample < SAMPLES; sample += 1) {
  let elapsedMs = 0;
  for (let offset = 0; offset < ACTIONS_PER_SAMPLE; offset += 100) {
    const count = Math.min(100, ACTIONS_PER_SAMPLE - offset);
    const startedAt = performance.now();
    for (let index = 0; index < count; index += 1) {
      checksum ^= actionTerminal.predict_printable(0x78, sample, actionInputSeq++, true);
      checksum ^= actionTerminal.predict_backspace(sample, actionInputSeq++);
    }
    elapsedMs += performance.now() - startedAt;
    drainNoopActions(actionTerminal, actionInputSeq - 1, actionDisplaySeq++);
  }
  actionSamples.push(elapsedMs / (ACTIONS_PER_SAMPLE * 2));
}
actionTerminal.free();

// ArrowUp/ArrowDown/Tab deliberately map to this authority-only operation.
// Measure the retained fail-closed policy directly so rejecting an unsafe
// predictor does not hide meaningful local CPU cost.
const authorityOnlyTerminal = createTrainedTerminal();
const authorityOnlyFlushSamples: number[] = [];
for (let sample = 0; sample < SAMPLES; sample += 1) {
  const startedAt = performance.now();
  for (let index = 0; index < ACTIONS_PER_SAMPLE; index += 1) {
    authorityOnlyTerminal.predict_seal(0);
  }
  authorityOnlyFlushSamples.push((performance.now() - startedAt) / ACTIONS_PER_SAMPLE);
}
if (authorityOnlyTerminal.has_predictions()) {
  throw new Error('authority-only flush retained speculative state');
}
authorityOnlyTerminal.free();

const projectionTerminal = createTrainedTerminal();
const projectionGeometry = createGeometryCountReader(memory, projectionTerminal);
let projectionInputSeq = 2;
let projectionDisplaySeq = 2;
const projectionSamples: number[] = [];
for (let sample = 0; sample < SAMPLES; sample += 1) {
  const startedAt = performance.now();
  for (let index = 0; index < PROJECTIONS_PER_SAMPLE; index += 1) {
    checksum ^= projectionTerminal.predict_printable(0x78, sample, projectionInputSeq++, true);
    projectionTerminal.build_geometry();
    checksum ^= projectionGeometry.glyphs();
    projectionTerminal.clear_prediction_render_dirty();
    checksum ^= projectionTerminal.predict_backspace(sample, projectionInputSeq++);
    projectionTerminal.build_geometry();
    checksum ^= projectionGeometry.glyphs();
    projectionTerminal.clear_prediction_render_dirty();
  }
  projectionSamples.push((performance.now() - startedAt) / (PROJECTIONS_PER_SAMPLE * 2));
  drainNoopActions(projectionTerminal, projectionInputSeq - 1, projectionDisplaySeq++);
  projectionTerminal.build_geometry();
  projectionTerminal.clear_prediction_render_dirty();
}
projectionTerminal.free();

// Exercise the new row-projection path itself: insert before an authoritative
// cell, then undo the edit and return the cursor to the same base state. The
// authoritative refresh stays outside the timed region.
const midlineTerminal = createTrainedTerminal();
const midlineGeometry = createGeometryCountReader(memory, midlineTerminal);
let midlineInputSeq = 2;
let midlineDisplaySeq = 2;
const midlineProjectionSamples: number[] = [];
for (let sample = 0; sample < SAMPLES; sample += 1) {
  const startedAt = performance.now();
  for (let index = 0; index < PROJECTIONS_PER_SAMPLE; index += 1) {
    checksum ^= midlineTerminal.predict_cursor_shift(-1, sample, midlineInputSeq++);
    checksum ^= midlineTerminal.predict_printable(0x78, sample, midlineInputSeq++, true);
    midlineTerminal.build_geometry();
    checksum ^= midlineGeometry.glyphs();
    midlineTerminal.clear_prediction_render_dirty();
    checksum ^= midlineTerminal.predict_backspace(sample, midlineInputSeq++);
    checksum ^= midlineTerminal.predict_cursor_shift(1, sample, midlineInputSeq++);
    midlineTerminal.build_geometry();
    checksum ^= midlineGeometry.glyphs();
    midlineTerminal.clear_prediction_render_dirty();
  }
  midlineProjectionSamples.push((performance.now() - startedAt) / (PROJECTIONS_PER_SAMPLE * 2));
  drainMidlineActions(
    midlineTerminal,
    midlineInputSeq - 1,
    midlineDisplaySeq,
    midlineDisplaySeq + 1,
  );
  midlineDisplaySeq += 2;
  midlineTerminal.build_geometry();
  midlineTerminal.clear_prediction_render_dirty();
}
midlineTerminal.free();

// Dense bounded edit: move to the beginning of a 120-cell owned line outside
// the timed span, then measure the full-row insert/remove
// projection. Cursor restoration and authenticated drain also stay untimed.
const longMidlineTerminal = createTrainedTerminal(LONG_MIDLINE_CELLS, 1_600);
const longMidlineGeometry = createGeometryCountReader(memory, longMidlineTerminal);
let longMidlineInputSeq = LONG_MIDLINE_CELLS + 1;
let longMidlineDisplaySeq = 2;
const longMidlineProjectionSamples: number[] = [];
for (let sample = 0; sample < SAMPLES; sample += 1) {
  for (let index = 0; index < LONG_MIDLINE_CELLS; index += 1) {
    requireAccepted(
      '120-cell cursor-left',
      longMidlineTerminal.predict_cursor_shift(-1, sample, longMidlineInputSeq++),
    );
  }

  const startedAt = performance.now();
  const inserted = longMidlineTerminal.predict_printable(0x78, sample, longMidlineInputSeq++, true);
  longMidlineTerminal.build_geometry();
  checksum ^= longMidlineGeometry.glyphs();
  longMidlineTerminal.clear_prediction_render_dirty();
  const removed = longMidlineTerminal.predict_backspace(sample, longMidlineInputSeq++);
  longMidlineTerminal.build_geometry();
  checksum ^= longMidlineGeometry.glyphs();
  longMidlineTerminal.clear_prediction_render_dirty();
  const elapsedMs = performance.now() - startedAt;

  // Assertions intentionally follow the timed span.
  requireAccepted('120-cell insert', inserted);
  requireAccepted('120-cell backspace', removed);
  longMidlineProjectionSamples.push(elapsedMs / 2);
  for (let index = 0; index < LONG_MIDLINE_CELLS; index += 1) {
    requireAccepted(
      '120-cell cursor-right',
      longMidlineTerminal.predict_cursor_shift(1, sample, longMidlineInputSeq++),
    );
  }
  drainLongMidlineActions(longMidlineTerminal, longMidlineInputSeq - 1, longMidlineDisplaySeq++);
  longMidlineTerminal.build_geometry();
  longMidlineTerminal.clear_prediction_render_dirty();
}
longMidlineTerminal.free();

const unchangedTerminal = createTrainedTerminal();
const unchangedGeometry = createGeometryCountReader(memory, unchangedTerminal);
const unchangedBuildSamples: number[] = [];
for (let sample = 0; sample < SAMPLES; sample += 1) {
  const startedAt = performance.now();
  for (let index = 0; index < UNCHANGED_BUILDS_PER_SAMPLE; index += 1) {
    unchangedTerminal.build_geometry();
    checksum ^= unchangedGeometry.cursors();
  }
  unchangedBuildSamples.push((performance.now() - startedAt) / UNCHANGED_BUILDS_PER_SAMPLE);
}
unchangedTerminal.free();

const exactPrefixSamples: number[] = [];
for (let sample = 0; sample < RECONCILE_SAMPLES; sample += 1) {
  const terminal = createTrainedTerminal();
  requireAccepted(
    'exact-prefix first prediction',
    terminal.predict_printable(0x62, sample, 2, true),
  );
  requireAccepted(
    'exact-prefix tail prediction',
    terminal.predict_printable(0x63, sample, 3, true),
  );
  const authority = encodeSingleCellDelta(terminal.cols(), terminal.rows(), 0x62, 2, 1, 2);
  if (!terminal.apply_delta_seq(authority, 2)) throw new Error('exact-prefix authority failed');
  const startedAt = performance.now();
  terminal.predict_reconcile(sample + 1, 500, 2, 2);
  exactPrefixSamples.push(performance.now() - startedAt);
  if (!terminal.has_predictions()) throw new Error('exact-prefix reconcile lost uncovered tail');
  terminal.free();
}

const mismatchDeferredSamples: number[] = [];
const mismatchSamples: number[] = [];
for (let sample = 0; sample < RECONCILE_SAMPLES; sample += 1) {
  const terminal = createTrainedTerminal();
  requireAccepted('mismatch prediction', terminal.predict_printable(0x62, sample, 2, true));
  const authority = encodeSingleCellDelta(terminal.cols(), terminal.rows(), 0x78, 2, 1, 2);
  if (!terminal.apply_delta_seq(authority, 2)) throw new Error('mismatch authority failed');
  let startedAt = performance.now();
  terminal.predict_reconcile(sample + 1, 500, 2, 2);
  mismatchDeferredSamples.push(performance.now() - startedAt);
  if (!terminal.has_predictions()) throw new Error('mismatch grace discarded state early');
  startedAt = performance.now();
  terminal.predict_reconcile(sample + 20, 500, 2, 2);
  mismatchSamples.push(performance.now() - startedAt);
  if (terminal.has_predictions()) throw new Error('mismatch reconcile retained tainted state');
  terminal.free();
}

report('shadow-prediction-action', actionSamples);
report('shadow-authority-only-flush', authorityOnlyFlushSamples);
report('shadow-prediction-projection', projectionSamples);
report('shadow-prediction-midline-projection', midlineProjectionSamples);
report('shadow-prediction-120-cell-midline-projection', longMidlineProjectionSamples);
report('shadow-prediction-unchanged-build', unchangedBuildSamples);
report('shadow-reconcile-exact-prefix-cold', exactPrefixSamples);
report('shadow-reconcile-mismatch-deferred-cold', mismatchDeferredSamples);
report('shadow-reconcile-mismatch-cold', mismatchSamples);
process.stdout.write(
  `shadow terminal benchmark: samples=${SAMPLES} actions/sample=${ACTIONS_PER_SAMPLE} ` +
    `projections/sample=${PROJECTIONS_PER_SAMPLE} unchanged/sample=${UNCHANGED_BUILDS_PER_SAMPLE} ` +
    `checksum=${checksum >>> 0}\n`,
);

function report(name: string, samples: readonly number[]): void {
  const summary = summarizeSamples(samples);
  for (const [suffix, value, percentile] of [
    ['p50', summary.median, 0.5],
    ['p95', summary.p95, 0.95],
    ['p99', summary.p99, 0.99],
  ] as const) {
    emitPerfMetric({
      name: `${name}-${suffix}`,
      value,
      unit: 'ms/op',
      direction: 'lower',
      percentile,
      sampleSize: samples.length,
    });
  }
  process.stdout.write(
    `${name}: p50=${summary.median.toFixed(6)}ms ` +
      `p95=${summary.p95.toFixed(6)}ms p99=${summary.p99.toFixed(6)}ms\n`,
  );
}

function createTrainedTerminal(cellCount = 1, pixelWidth = 960) {
  const terminal = wasm.init_regular(pixelWidth, 640, fontBytes, 14, 1.2, 1);
  const cols = terminal.cols();
  const rows = terminal.rows();
  if (cols <= cellCount || rows < 1) {
    throw new Error(`unexpected benchmark grid ${cols}x${rows} for ${cellCount} cells`);
  }
  const initial = encodeEmptySnapshot(cols, rows);
  if (!terminal.apply_state_seq(initial, 0)) {
    throw new Error(`failed to establish prediction mode: ${terminal.take_last_error()}`);
  }
  terminal.commit_presentation_state();
  for (let index = 0; index < cellCount; index += 1) {
    requireAccepted(
      'seed prediction',
      terminal.predict_printable(LETTER_A_CODE_POINT, 0, index + 1, true),
    );
  }
  const authority = encodeAsciiRowDelta(
    cols,
    rows,
    new Uint8Array(cellCount).fill(LETTER_A_CODE_POINT),
    cellCount,
  );
  if (!terminal.apply_delta_seq(authority, 1)) {
    throw new Error(
      `failed to apply prediction benchmark authority: ${terminal.take_last_error()}`,
    );
  }
  terminal.commit_presentation_state();
  terminal.predict_reconcile(1, 500, cellCount, cellCount);
  if (terminal.has_predictions()) throw new Error('failed to train prediction benchmark');
  terminal.build_geometry();
  terminal.clear_prediction_render_dirty();
  return terminal;
}

function drainNoopActions(
  terminal: ReturnType<typeof wasm.init_regular>,
  inputSeq: number,
  seq: number,
) {
  const authority = encodeSingleCellDelta(terminal.cols(), terminal.rows(), 0x20, 1, 1, seq);
  if (!terminal.apply_delta_seq(authority, seq)) {
    throw new Error(`failed to drain prediction benchmark: ${terminal.take_last_error()}`);
  }
  terminal.commit_presentation_state();
  terminal.predict_reconcile(seq, 500, inputSeq, inputSeq);
  if (terminal.has_predictions()) throw new Error('prediction benchmark drain left pending work');
}

function drainMidlineActions(
  terminal: ReturnType<typeof wasm.init_regular>,
  inputSeq: number,
  firstSeq: number,
  secondSeq: number,
) {
  const first = encodeSingleCellDelta(terminal.cols(), terminal.rows(), 0x61, 1, 0, firstSeq);
  const second = encodeSingleCellDelta(terminal.cols(), terminal.rows(), 0x20, 1, 1, secondSeq);
  if (!terminal.apply_delta_seq(first, firstSeq) || !terminal.apply_delta_seq(second, secondSeq)) {
    throw new Error(`failed to drain midline benchmark: ${terminal.take_last_error()}`);
  }
  terminal.commit_presentation_state();
  terminal.predict_reconcile(secondSeq, 500, inputSeq, inputSeq);
  if (terminal.has_predictions()) {
    throw new Error('midline prediction benchmark drain left pending work');
  }
}

function drainLongMidlineActions(
  terminal: ReturnType<typeof wasm.init_regular>,
  inputSeq: number,
  seq: number,
) {
  const authority = new Uint8Array(LONG_MIDLINE_CELLS + 1).fill(0x61);
  authority[LONG_MIDLINE_CELLS] = 0x20;
  const frame = encodeAsciiRowDelta(
    terminal.cols(),
    terminal.rows(),
    authority,
    LONG_MIDLINE_CELLS,
    0,
    seq,
  );
  if (!terminal.apply_delta_seq(frame, seq)) {
    throw new Error(`failed to drain 120-cell benchmark: ${terminal.take_last_error()}`);
  }
  terminal.commit_presentation_state();
  terminal.predict_reconcile(seq, 500, inputSeq, inputSeq);
  if (terminal.has_predictions()) {
    throw new Error('120-cell prediction benchmark drain left pending work');
  }
}

/**
 * The closure digest (u64; zero claims no complete frame), the scroll serial
 * (u32; this fixture never scrolls) and the echo horizon (u32; zero claims no
 * answered input) end the body header, all zero. A field added before or
 * between them moves these offsets: fail here rather than encode rows the
 * decoder rejects as `display_row_invalid`.
 */
function skipHeaderTail(offset: number): number {
  if (
    offset !== DISPLAY_CLOSURE_DIGEST_OFFSET ||
    offset + 8 !== DISPLAY_SCROLL_SERIAL_OFFSET ||
    DISPLAY_SCROLL_SERIAL_OFFSET + 4 !== DISPLAY_ECHO_HORIZON_OFFSET ||
    DISPLAY_ECHO_HORIZON_OFFSET + 4 !== DISPLAY_ROWS_OFFSET
  ) {
    throw new Error(`display body header drifted: closure digest written at ${offset}`);
  }
  return DISPLAY_ROWS_OFFSET;
}

function encodeSingleCellDelta(
  cols: number,
  rows: number,
  codepoint: number,
  cursorCol: number,
  left = 0,
  frameId = 1,
): Uint8Array {
  return encodeAsciiRowDelta(cols, rows, Uint8Array.of(codepoint), cursorCol, left, frameId);
}

function encodeAsciiRowDelta(
  cols: number,
  rows: number,
  codepoints: Uint8Array,
  cursorCol: number,
  left = 0,
  frameId = 1,
): Uint8Array {
  // One display header, one row prefix, then the row's colour-mode byte
  // followed by two bytes per default-style ASCII cell. Mode 0 is indexed,
  // which is what a row carrying no colours at all always selects.
  const payloadBytes = 1 + codepoints.byteLength * 2;
  const out = new Uint8Array(
    DISPLAY_STREAM_HEADER_BYTES +
      DISPLAY_PATCH_BODY_HEADER_BYTES +
      DISPLAY_ROW_PREFIX_BYTES +
      payloadBytes,
  );
  let offset = DISPLAY_STREAM_HEADER_BYTES;
  out[offset++] = DISPLAY_PROTOCOL_VERSION;
  out[offset++] = 0;
  writeU16(out, offset, cols);
  offset += 2;
  writeU16(out, offset, rows);
  offset += 2;
  writeU16(out, offset, cursorCol);
  offset += 2;
  writeU16(out, offset, 0);
  offset += 2;
  out[offset++] = 0x11;
  writeU16(out, offset, PREDICTION_SAFE_MODE);
  offset += 2;
  writeU32(out, offset, frameId);
  offset += 4;
  writeU32(out, offset, frameId);
  offset += 4;
  writeU16(out, offset, 0);
  offset += 2;
  writeU16(out, offset, 1);
  offset += 2;
  writeU16(out, offset, 1);
  offset += 2;
  writeU16(out, offset, 0);
  offset += 2;
  writeU16(out, offset, 0);
  offset += 2;
  writeU32(out, offset, 0);
  offset += 4;
  // Demand serial.
  writeU32(out, offset, 0);
  offset += 4;
  offset = skipHeaderTail(offset);
  writeU16(out, offset, 0);
  offset += 2;
  writeU16(out, offset, left);
  offset += 2;
  writeU16(out, offset, codepoints.byteLength);
  offset += 2;
  writeU16(out, offset, payloadBytes);
  offset += 2;
  out[offset++] = DISPLAY_COLOR_MODE_INDEXED;
  for (const codepoint of codepoints) {
    out[offset++] = 0;
    out[offset++] = codepoint;
  }
  return out;
}

function encodeEmptySnapshot(cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(DISPLAY_STREAM_HEADER_BYTES + DISPLAY_PATCH_BODY_HEADER_BYTES);
  let offset = DISPLAY_STREAM_HEADER_BYTES;
  out[offset++] = DISPLAY_PROTOCOL_VERSION;
  out[offset++] = 1;
  writeU16(out, offset, cols);
  offset += 2;
  writeU16(out, offset, rows);
  offset += 2;
  writeU16(out, offset, 0);
  offset += 2;
  writeU16(out, offset, 0);
  offset += 2;
  out[offset++] = 0x11;
  writeU16(out, offset, PREDICTION_SAFE_MODE);
  offset += 2;
  writeU32(out, offset, 0);
  offset += 4;
  writeU32(out, offset, 0);
  offset += 4;
  writeU16(out, offset, 0);
  offset += 2;
  writeU16(out, offset, 1);
  offset += 2;
  writeU16(out, offset, 0);
  offset += 2;
  writeU16(out, offset, 0);
  offset += 2;
  writeU16(out, offset, 0);
  return out;
}

function validateTimedBatchesAccepted(): void {
  const action = createTrainedTerminal();
  let inputSeq = 2;
  for (let index = 0; index < Math.min(ACTIONS_PER_SAMPLE, 100); index += 1) {
    requireAccepted(
      'action preflight printable',
      action.predict_printable(0x78, 0, inputSeq++, true),
    );
    requireAccepted('action preflight backspace', action.predict_backspace(0, inputSeq++));
  }
  action.free();

  const projection = createTrainedTerminal();
  inputSeq = 2;
  for (let index = 0; index < PROJECTIONS_PER_SAMPLE; index += 1) {
    requireAccepted(
      'projection preflight printable',
      projection.predict_printable(0x78, 0, inputSeq++, true),
    );
    requireAccepted('projection preflight backspace', projection.predict_backspace(0, inputSeq++));
  }
  projection.free();

  const midline = createTrainedTerminal();
  inputSeq = 2;
  for (let index = 0; index < PROJECTIONS_PER_SAMPLE; index += 1) {
    requireAccepted('midline preflight left', midline.predict_cursor_shift(-1, 0, inputSeq++));
    requireAccepted(
      'midline preflight insert',
      midline.predict_printable(0x78, 0, inputSeq++, true),
    );
    requireAccepted('midline preflight remove', midline.predict_backspace(0, inputSeq++));
    requireAccepted('midline preflight right', midline.predict_cursor_shift(1, 0, inputSeq++));
  }
  midline.free();
}

function requireAccepted(label: string, result: number): void {
  if (result === 0) throw new Error(`${label} was rejected`);
}

function writeU16(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 8) & 0xff;
  out[offset + 1] = value & 0xff;
}

function writeU32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}
